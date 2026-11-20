// Dados do restaurante do utilizador autenticado (nome, imagem, fuso horário, taxa de serviço, pausa de pedidos).
import { FEATURES, type FeatureKey } from '../../../../shared/plans';
import { RestaurantUpdateInput } from '../../../../shared/schemas';
import type { StaffRole } from '../../../../shared/status';
import type { PlanOverview, RestaurantSettings } from '../../../../shared/types';
import { updatePartial } from '../../db/dynamic';
import { audit } from '../../lib/audit';
import { purgeOrphanAssets } from '../../lib/assets';
import { notFound } from '../../lib/errors';
import { requireFeature, restaurantFeatures } from '../../lib/plans';
import { json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

const staffRoles: ReadonlyArray<StaffRole> = ['manager', 'waiter', 'kitchen'];

const COLUMNS =
  'id, name, slug, description, logo_url, cover_url, accent_color, address, phone, email, whatsapp, maps_url, opening_hours, theme, font, is_demo, status, accepting_orders, timezone, currency, service_fee_bps, menu_base_url';

interface Row extends Omit<RestaurantSettings, 'service_fee_bps'> {
  service_fee_bps: number;
}

async function getCurrent(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  const row = await ctx.deps.db.as({ role: a.role as StaffRole, restaurantId: rid, userId: a.userId }, async (tx) => {
    const [r] = await tx.unsafe<Row>(`SELECT ${COLUMNS} FROM restaurants WHERE id = $1`, [rid]);
    return r ?? null;
  });
  if (!row) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
  return json({ restaurant: row });
}

async function updateCurrent(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  const input = await ctx.body(RestaurantUpdateInput);
  // o que o plano não inclui é recusado no servidor (esconder o botão no ecrã não chega)
  const db = ctx.deps.db;
  if (input.accent_color || input.theme !== undefined) await requireFeature(db, rid, 'advanced_branding', 'a personalização de cor e tema');
  if (input.font !== undefined) await requireFeature(db, rid, 'exclusive_branding', 'a personalização exclusiva');
  if (input.whatsapp) await requireFeature(db, rid, 'whatsapp_orders', 'pedidos por WhatsApp');
  // o horário vai como objeto: a base de dados converte-o em JSON (se fosse texto, ficaria guardado como uma "frase" e seria recusado)
  const patch: Record<string, unknown> = { ...input };
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: rid, userId: a.userId }, async (tx) => {
    const r = await updatePartial<Row>(tx, 'restaurants', {
      columns: ['name', 'description', 'logo_url', 'cover_url', 'accent_color', 'address', 'phone', 'email', 'whatsapp', 'maps_url', 'opening_hours', 'theme', 'font', 'timezone', 'service_fee_bps', 'accepting_orders'],
      where: 'id = $1',
      whereParams: [rid],
      returning: COLUMNS,
    }, patch);
    if (!r) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
    await purgeOrphanAssets(tx, rid);
    await audit(tx, {
      restaurantId: rid, actorId: a.userId, actorRole: a.role, action: 'restaurant.update', entityType: 'restaurant', entityId: rid,
      metadata: { fields: Object.keys(input), ...(input.accepting_orders !== undefined ? { accepting_orders: input.accepting_orders } : {}), ...(input.service_fee_bps !== undefined ? { service_fee_bps: input.service_fee_bps } : {}) },
      ip: ctx.ip,
    });
    return r;
  });
  ctx.deps.hub.publishRestaurant(rid, { type: 'menu.changed', at: new Date().toISOString() });
  return json({ restaurant: row });
}

/** O plano do restaurante, o que inclui e o espaço de ficheiros usado. */
async function getPlan(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  const rows = await ctx.deps.db.system((tx) =>
    tx<{ code: string; name: string; tagline: string; status: string; valid_until: string | null; used: string }>`
      SELECT p.code, p.name, p.tagline, s.status, s.valid_until::text AS valid_until,
             (SELECT coalesce(sum(byte_size), 0) FROM assets WHERE restaurant_id = ${rid})::text AS used
      FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.restaurant_id = ${rid}`,
  );
  const features = [...(await restaurantFeatures(ctx.deps.db, rid))] as FeatureKey[];
  const r = rows[0];
  const overview: PlanOverview = {
    plan: { code: r?.code ?? 'starter', name: r?.name ?? 'Starter', tagline: r?.tagline ?? '' },
    status: (r?.status as PlanOverview['status']) ?? 'ativa',
    valid_until: r?.valid_until ?? null,
    features,
    storage: { used_bytes: Number(r?.used ?? 0), quota_bytes: ctx.deps.config.assetQuotaBytes },
  };
  return json({ plan: overview, catalog: Object.values(FEATURES), contact: ctx.deps.config.commercial });
}

export const restaurantRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/restaurants/current/plan', access: { roles: ['manager'] }, handler: getPlan },
  { method: 'GET', path: '/api/restaurants/current', access: { roles: staffRoles }, handler: getCurrent },
  { method: 'PATCH', path: '/api/restaurants/current', access: { roles: ['manager'] }, handler: updateCurrent },
];
