// Mesas e QR Codes. O token do QR Code só é visível ao gerente; pode ser revogado e gerado de novo.
import { TableCreateInput, TableUpdateInput, uuid } from '../../../../shared/schemas';
import type { StaffRole } from '../../../../shared/status';
import { iso, pgCode } from '../../db/client';
import { audit } from '../../lib/audit';
import { randomToken } from '../../lib/crypto';
import { requireFeature } from '../../lib/plans';
import { conflict, notFound } from '../../lib/errors';
import { created, json, noContent } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

const staffRoles: ReadonlyArray<StaffRole> = ['manager', 'waiter', 'kitchen'];

interface TableRow {
  id: string;
  table_number: number;
  label: string | null;
  active: boolean;
  qr_token?: string;
  qr_rotated_at?: Date;
  active_orders: number;
  ready_orders: number;
}

function view(row: TableRow, baseUrl: string) {
  return {
    id: row.id,
    table_number: row.table_number,
    label: row.label,
    active: row.active,
    active_orders: row.active_orders,
    ready_orders: row.ready_orders,
    ...(row.qr_token ? { qr_url: `${baseUrl}/menu/${row.qr_token}`, qr_rotated_at: iso(row.qr_rotated_at) } : {}),
  };
}

function auth(ctx: Ctx) {
  const a = ctx.auth!;
  return { role: a.role as StaffRole, restaurantId: a.restaurantId!, userId: a.userId };
}

async function listTables(ctx: Ctx): Promise<Response> {
  const a = auth(ctx);
  const tables = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx<{ menu_base_url: string | null }>`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    const baseUrl = r?.menu_base_url ?? ctx.deps.config.publicBaseUrl;
    // o token só é pedido (e só pode ser lido) pelo gerente
    const rows =
      a.role === 'manager'
        ? await tx<TableRow>`
            SELECT t.id, t.table_number, t.label, t.active, t.qr_token, t.qr_rotated_at,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status IN ('novo', 'em_preparacao', 'pronto')) AS active_orders,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status = 'pronto') AS ready_orders
            FROM restaurant_tables t WHERE t.restaurant_id = ${a.restaurantId} ORDER BY t.table_number`
        : await tx<TableRow>`
            SELECT t.id, t.table_number, t.label, t.active,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status IN ('novo', 'em_preparacao', 'pronto')) AS active_orders,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status = 'pronto') AS ready_orders
            FROM restaurant_tables t WHERE t.restaurant_id = ${a.restaurantId} ORDER BY t.table_number`;
    return rows.map((row) => view(row, baseUrl));
  });
  return json({ tables });
}

async function createTable(ctx: Ctx): Promise<Response> {
  await requireFeature(ctx.deps.db, ctx.auth!.restaurantId!, 'tables', 'a gestão de mesas');
  const a = auth(ctx);
  const input = await ctx.body(TableCreateInput);
  const table = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [row] = await tx<TableRow>`
      INSERT INTO restaurant_tables (restaurant_id, table_number, label, qr_token)
      VALUES (${a.restaurantId}, ${input.table_number}, ${input.label}, ${randomToken(16)})
      RETURNING id, table_number, label, active, qr_token, qr_rotated_at, 0 AS active_orders, 0 AS ready_orders`;
    const [r] = await tx<{ menu_base_url: string | null }>`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'table.create',
      entityType: 'table', entityId: row!.id, metadata: { table_number: input.table_number }, ip: ctx.ip,
    });
    return view(row!, r?.menu_base_url ?? ctx.deps.config.publicBaseUrl);
  });
  return created({ table });
}

async function updateTable(ctx: Ctx): Promise<Response> {
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
  const input = await ctx.body(TableUpdateInput);
  const table = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [current] = await tx<{ label: string | null; active: boolean }>`
      SELECT label, active FROM restaurant_tables WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!current) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
    const label = 'label' in input ? (input.label ?? null) : current.label;
    const active = input.active ?? current.active;
    const [row] = await tx<TableRow>`
      UPDATE restaurant_tables SET label = ${label}, active = ${active}
      WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}
      RETURNING id, table_number, label, active, qr_token, qr_rotated_at, 0 AS active_orders, 0 AS ready_orders`;
    const [r] = await tx<{ menu_base_url: string | null }>`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'table.update',
      entityType: 'table', entityId: id.data, metadata: { table_number: row!.table_number, active, active_changed: active !== current.active, label_changed: label !== current.label }, ip: ctx.ip,
    });
    return view(row!, r?.menu_base_url ?? ctx.deps.config.publicBaseUrl);
  });
  return json({ table });
}

/** Revoga o QR Code atual (o antigo deixa de funcionar de imediato) e gera um novo. */
async function regenerateQr(ctx: Ctx): Promise<Response> {
  await requireFeature(ctx.deps.db, ctx.auth!.restaurantId!, 'tables', 'a gestão de mesas');
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
  const table = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [row] = await tx<TableRow>`
      UPDATE restaurant_tables SET qr_token = ${randomToken(16)}, qr_rotated_at = now()
      WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}
      RETURNING id, table_number, label, active, qr_token, qr_rotated_at, 0 AS active_orders, 0 AS ready_orders`;
    if (!row) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
    // a sessão em curso deixa de ser acessível pelo QR antigo; fecha-se para começar limpa
    await tx`UPDATE table_sessions SET closed_at = now(), closed_by = ${a.userId}, close_reason = 'qr_renovado'
             WHERE table_id = ${id.data} AND restaurant_id = ${a.restaurantId} AND closed_at IS NULL`;
    const [r] = await tx<{ menu_base_url: string | null }>`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'table.qr_regenerated',
      entityType: 'table', entityId: id.data, metadata: { table_number: row.table_number }, ip: ctx.ip,
    });
    return view(row, r?.menu_base_url ?? ctx.deps.config.publicBaseUrl);
  });
  return json({ table });
}

async function deleteTable(ctx: Ctx): Promise<Response> {
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
  try {
    await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
      const rows = await tx`DELETE FROM restaurant_tables WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} RETURNING id`;
      if (rows.length === 0) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
      await audit(tx, {
        restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'table.delete',
        entityType: 'table', entityId: id.data, ip: ctx.ip,
      });
    });
  } catch (err) {
    // uma mesa com pedidos registados não se apaga (o histórico e os relatórios dependem dela): desativa-se
    if (pgCode(err) === '23503') throw conflict('Esta mesa já tem pedidos registados. Desative-a em vez de a apagar.', 'TABLE_HAS_ORDERS');
    throw err;
  }
  return noContent();
}

/** "Libertar mesa": termina a sessão atual, para que o próximo grupo comece com o histórico limpo. */
async function closeSession(ctx: Ctx): Promise<Response> {
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
  const closed = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [t] = await tx<{ table_number: number }>`SELECT table_number FROM restaurant_tables WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
    if (!t) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
    const rows = await tx`
      UPDATE table_sessions SET closed_at = now(), closed_by = ${a.userId}, close_reason = 'mesa_libertada'
      WHERE table_id = ${id.data} AND restaurant_id = ${a.restaurantId} AND closed_at IS NULL
      RETURNING id`;
    if (rows.length > 0) {
      await audit(tx, {
        restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'table.session_closed',
        entityType: 'table', entityId: id.data, metadata: { table_number: t.table_number }, ip: ctx.ip,
      });
    }
    return rows.length > 0;
  });
  return json({ closed });
}

export const tableRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/tables', access: { roles: staffRoles }, handler: listTables },
  { method: 'POST', path: '/api/tables', access: { roles: ['manager'] }, handler: createTable },
  { method: 'PATCH', path: '/api/tables/:id', access: { roles: ['manager'] }, handler: updateTable },
  { method: 'POST', path: '/api/tables/:id/regenerate-qr', access: { roles: ['manager'] }, handler: regenerateQr, noBody: true },
  { method: 'DELETE', path: '/api/tables/:id', access: { roles: ['manager'] }, handler: deleteTable, noBody: true },
  { method: 'POST', path: '/api/tables/:id/close-session', access: { roles: ['manager', 'waiter'] }, handler: closeSession, noBody: true },
];
