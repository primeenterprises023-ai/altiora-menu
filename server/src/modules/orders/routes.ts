// Rotas da equipa para pedidos: listar, consultar, registar pedidos presenciais e mudar o estado.
import { z } from 'zod';
import { OrderStatusInput, StaffCreateOrderInput, uuid } from '../../../../shared/schemas';
import { ACTIVE_STATUSES, ORDER_STATUSES, canTransition, transitionNeedsReason, type OrderStatus, type StaffRole } from '../../../../shared/status';
import type { OrderView } from '../../../../shared/types';
import { iso, lockIdempotencyKey, pgCode, pgConstraint } from '../../db/client';
import { audit } from '../../lib/audit';
import { randomToken } from '../../lib/crypto';
import { HttpError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { json, created } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';
import { getOrder, insertOrder, listOrders, priceOrder } from './service';
import { ensureTableSession } from './table-sessions';
import { requireFeature } from '../../lib/plans';

const staffRoles: ReadonlyArray<StaffRole> = ['manager', 'waiter', 'kitchen'];

function staffAuth(ctx: Ctx) {
  const a = ctx.auth!;
  return { role: a.role as StaffRole, restaurantId: a.restaurantId!, userId: a.userId };
}

const ListQuery = z.object({
  scope: z.enum(['active', 'history']).default('active'),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().datetime().optional(),
  table_id: uuid.optional(),
  /** "1": só pedidos com valor por receber (empregado e gerente). */
  unpaid: z.enum(['1']).optional(),
});

async function list(ctx: Ctx): Promise<Response> {
  const parsed = ListQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success) throw badRequest('Parâmetros de pesquisa inválidos.', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })), 'VALIDATION_ERROR');
  const q = parsed.data;
  const a = staffAuth(ctx);
  if (q.unpaid && a.role === 'kitchen') throw forbidden('A cozinha não tem acesso a pagamentos.', 'FORBIDDEN');

  let statuses: OrderStatus[];
  if (q.status) {
    statuses = q.status.split(',').map((s) => s.trim()).filter((s): s is OrderStatus => (ORDER_STATUSES as readonly string[]).includes(s));
    if (statuses.length === 0) throw badRequest('Estado inválido.', undefined, 'VALIDATION_ERROR');
  } else if (q.unpaid) {
    statuses = [...ACTIVE_STATUSES, 'entregue'];
  } else {
    statuses = q.scope === 'active' ? [...ACTIVE_STATUSES] : ['entregue', 'cancelado'];
  }

  const orders = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, (tx) =>
    listOrders(tx, a.restaurantId, {
      statuses,
      before: q.before ? new Date(q.before) : undefined,
      tableId: q.table_id,
      unpaid: q.unpaid === '1',
      limit: q.limit,
      direction: q.scope === 'active' && !q.unpaid ? 'asc' : 'desc',
    }),
  );
  return json({ server_time: new Date().toISOString(), orders });
}

async function detail(ctx: Ctx): Promise<Response> {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  const a = staffAuth(ctx);
  const result = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const order = await getOrder(tx, a.restaurantId, id.data);
    if (!order) return null;
    const history = await tx<{ previous_status: string | null; new_status: string; changed_by_role: string | null; reason: string | null; created_at: Date }>`
      SELECT previous_status, new_status, changed_by_role, reason, created_at
      FROM order_status_history WHERE order_id = ${id.data} ORDER BY id`;
    return {
      order,
      history: history.map((h) => ({ ...h, created_at: iso(h.created_at)! })),
    };
  });
  if (!result) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  return json(result);
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,100}$/;

/**
 * Pedido registado por um empregado/gerente (clientes que não usam o QR Code).
 * Se vier o cabeçalho Idempotency-Key, repetir o mesmo envio (duplo toque, rede lenta) devolve o pedido já criado em vez de criar outro.
 */
async function createManual(ctx: Ctx): Promise<Response> {
  const a = staffAuth(ctx);
  await requireFeature(ctx.deps.db, a.restaurantId, 'orders', 'pedidos digitais');
  const rawKey = ctx.req.headers.get('idempotency-key');
  let key: string | null = null;
  if (rawKey !== null && rawKey !== '') {
    if (!IDEMPOTENCY_RE.test(rawKey)) throw badRequest('Idempotency-Key inválida (16 a 100 caracteres: letras, números, - e _).', undefined, 'IDEMPOTENCY_KEY_INVALID');
    key = rawKey;
  }
  const input = await ctx.body(StaffCreateOrderInput);
  const { limits, tableSessionMinutes } = ctx.deps.config;

  const attempt = () =>
    ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
      if (key) {
        // envios simultâneos com a mesma chave passam um de cada vez: o segundo vê o pedido do primeiro e devolve-o
        await lockIdempotencyKey(tx, a.restaurantId, key);
        const [prior] = await tx<{ id: string; source: string; created_by: string | null }>`
          SELECT id, source, created_by FROM orders WHERE restaurant_id = ${a.restaurantId} AND idempotency_key = ${key}`;
        if (prior) {
          // a mesma chave só devolve o pedido de quem o criou; outra pessoa a usar a chave é um erro, não uma repetição
          if (prior.source !== 'staff' || prior.created_by !== a.userId) throw conflict('Esta chave já foi usada por outro pedido.', 'IDEMPOTENCY_KEY_REUSED');
          const existing = (await getOrder(tx, a.restaurantId, prior.id))!;
          return { order: existing, tableNumber: existing.table_number, replayed: true };
        }
      }
      const [table] = await tx<{ id: string; table_number: number; active: boolean }>`
        SELECT id, table_number, active FROM restaurant_tables WHERE id = ${input.table_id} AND restaurant_id = ${a.restaurantId}`;
      if (!table) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
      if (!table.active) throw conflict('Esta mesa está desativada.', 'TABLE_UNAVAILABLE');
      const [r] = await tx<{ service_fee_bps: number }>`SELECT service_fee_bps FROM restaurants WHERE id = ${a.restaurantId}`;
      const priced = await priceOrder(tx, a.restaurantId, { items: input.items, notes: input.notes }, r!.service_fee_bps, limits);
      const sessionId = await ensureTableSession(tx, { restaurantId: a.restaurantId, tableId: table.id }, tableSessionMinutes);
      const { id } = await insertOrder(tx, {
        restaurantId: a.restaurantId,
        tableId: table.id,
        tableSessionId: sessionId,
        publicCode: randomToken(16),
        source: 'staff',
        createdBy: a.userId,
        priced,
        notes: input.notes,
        idempotencyKey: key,
      });
      const order = (await getOrder(tx, a.restaurantId, id))!;
      return { order, tableNumber: table.table_number, replayed: false };
    });

  let out: Awaited<ReturnType<typeof attempt>>;
  try {
    out = await attempt();
  } catch (err) {
    // dois envios ao mesmo tempo com a mesma chave: o segundo bate na restrição única; repetimos para devolver o primeiro
    if (key && pgCode(err) === '23505' && pgConstraint(err) === 'orders_idem_uq') out = await attempt();
    else throw err;
  }

  if (!out.replayed) {
    ctx.deps.hub.publishRestaurant(a.restaurantId, {
      type: 'order.created',
      order_id: out.order.id,
      order_number: out.order.order_number,
      table_number: out.tableNumber,
      at: new Date().toISOString(),
    });
  }
  return out.replayed ? json({ order: out.order, replayed: true }) : created({ order: out.order });
}

/** Valida e aplica uma mudança de estado. A base de dados volta a validar (defesa em profundidade). */
async function transition(ctx: Ctx): Promise<Response> {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  const a = staffAuth(ctx);
  const input = await ctx.body(OrderStatusInput);

  const out = await ctx.deps.db.as(
    { role: a.role, restaurantId: a.restaurantId, userId: a.userId, reason: input.reason ?? null },
    async (tx) => {
      const [cur] = await tx<{ status: OrderStatus; public_code: string; order_number: number; table_number: number }>`
        SELECT status, public_code, order_number, table_number FROM orders
        WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
      if (!cur) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
      if (input.from && input.from !== cur.status) {
        throw conflict('O pedido já foi alterado por outra pessoa. A lista foi atualizada.', 'STATE_CONFLICT', { current: cur.status });
      }
      if (cur.status === input.to) throw conflict('O pedido já está neste estado.', 'STATE_CONFLICT', { current: cur.status });
      if (!canTransition(a.role, cur.status, input.to)) {
        const anyone = staffRoles.some((r) => canTransition(r, cur.status, input.to));
        throw anyone
          ? forbidden('O seu perfil não pode fazer esta alteração de estado.', 'TRANSITION_NOT_ALLOWED')
          : new HttpError(409, 'INVALID_TRANSITION', 'Esta alteração de estado não é permitida.');
      }
      if (transitionNeedsReason(cur.status, input.to) && !input.reason) {
        throw unprocessable('Indique o motivo desta alteração.', 'REASON_REQUIRED');
      }
      await tx`UPDATE orders SET status = ${input.to} WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
      if (a.role === 'manager' && (input.to === 'cancelado' || transitionNeedsReason(cur.status, input.to))) {
        await audit(tx, {
          restaurantId: a.restaurantId,
          actorId: a.userId,
          actorRole: a.role,
          action: input.to === 'cancelado' ? 'order.cancel' : 'order.correct',
          entityType: 'order',
          entityId: id.data,
          metadata: { from: cur.status, to: input.to, reason: input.reason },
          ip: ctx.ip,
        });
      }
      const order = (await getOrder(tx, a.restaurantId, id.data))!;
      return { order, from: cur.status, publicCode: cur.public_code };
    },
  );

  const at = new Date().toISOString();
  ctx.deps.hub.publishRestaurant(a.restaurantId, {
    type: 'order.status',
    order_id: out.order.id,
    order_number: out.order.order_number,
    table_number: out.order.table_number,
    from: out.from,
    to: out.order.status,
    at,
  });
  ctx.deps.hub.publishOrder(out.publicCode, { type: 'order.state', status: out.order.status, at });
  return json({ order: out.order satisfies OrderView });
}

export const orderRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/orders', access: { roles: staffRoles }, handler: list },
  { method: 'GET', path: '/api/orders/:id', access: { roles: staffRoles }, handler: detail },
  { method: 'POST', path: '/api/orders', access: { roles: ['manager', 'waiter'] }, handler: createManual },
  { method: 'POST', path: '/api/order-status/:id', access: { roles: staffRoles }, handler: transition },
];
