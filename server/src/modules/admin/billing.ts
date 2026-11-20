// Planos, preços e assinaturas (painel da Altiora) e utilização da plataforma.
// Não há pagamentos no sistema: a assinatura tem só o plano, o estado e a data até à qual está válida.
import { DEFAULT_PLANS, isFeatureKey, type FeatureKey } from '../../../../shared/plans';
import { PlanCreateInput, PlanUpdateInput, SubscriptionUpdateInput, uuid } from '../../../../shared/schemas';
import type { AdminPlan, AdminUsageRow } from '../../../../shared/types';
import { iso, pgCode, type Tx } from '../../db/client';
import { audit } from '../../lib/audit';
import { clearFeatureCache } from '../../lib/plans';
import { HttpError, conflict, notFound } from '../../lib/errors';
import { created, json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

interface PlanRow { code: string; name: string; tagline: string; display_order: number; highlighted: boolean; active: boolean; features: string[]; restaurants: number }
interface PriceRow { plan_code: string; currency: string; monthly_cents: string; yearly_cents: string | null }

async function loadPlans(tx: Tx): Promise<AdminPlan[]> {
  const plans = await tx<PlanRow>`
    SELECT p.code, p.name, p.tagline, p.display_order, p.highlighted, p.active, p.features,
           (SELECT count(*)::int FROM subscriptions s WHERE s.plan_code = p.code) AS restaurants
    FROM plans p ORDER BY p.display_order, p.code`;
  const prices = await tx<PriceRow>`SELECT plan_code, currency, monthly_cents, yearly_cents FROM plan_prices ORDER BY currency`;
  return plans.map((p) => ({
    code: p.code, name: p.name, tagline: p.tagline, display_order: p.display_order, highlighted: p.highlighted, active: p.active,
    features: p.features.filter(isFeatureKey) as FeatureKey[],
    restaurants: p.restaurants,
    prices: prices.filter((x) => x.plan_code === p.code).map((x) => ({ currency: x.currency, monthly_cents: Number(x.monthly_cents), yearly_cents: x.yearly_cents === null ? null : Number(x.yearly_cents) })),
  }));
}

async function writePrices(tx: Tx, code: string, prices: Array<{ currency: string; monthly_cents: number; yearly_cents: number | null }>): Promise<void> {
  await tx`DELETE FROM plan_prices WHERE plan_code = ${code}`;
  for (const p of prices) {
    await tx`INSERT INTO plan_prices (plan_code, currency, monthly_cents, yearly_cents) VALUES (${code}, ${p.currency}, ${p.monthly_cents}, ${p.yearly_cents})`;
  }
}

async function listPlans(ctx: Ctx): Promise<Response> {
  const plans = await ctx.deps.db.as(ctx.dbContext(), loadPlans);
  return json({ plans });
}

async function createPlan(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const input = await ctx.body(PlanCreateInput);
  try {
    const plan = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
      await tx`INSERT INTO plans (code, name, tagline, display_order, highlighted, active, features)
               VALUES (${input.code}, ${input.name}, ${input.tagline}, ${input.display_order}, ${input.highlighted}, ${input.active}, ${input.features}::text[])`;
      await writePrices(tx, input.code, input.prices);
      await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: 'platform', action: 'platform.plan.create', entityType: 'plan', metadata: { code: input.code }, ip: ctx.ip });
      return (await loadPlans(tx)).find((p) => p.code === input.code)!;
    });
    clearFeatureCache();
    return created({ plan });
  } catch (err) {
    if (pgCode(err) === '23505') throw conflict('Já existe um plano com este código.', 'PLAN_EXISTS');
    throw err;
  }
}

async function updatePlan(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const code = ctx.params.code ?? '';
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(code)) throw notFound('Plano não encontrado.', 'PLAN_NOT_FOUND');
  const input = await ctx.body(PlanUpdateInput);
  const plan = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [exists] = await tx`SELECT 1 FROM plans WHERE code = ${code}`;
    if (!exists) throw notFound('Plano não encontrado.', 'PLAN_NOT_FOUND');
    if (input.name !== undefined) await tx`UPDATE plans SET name = ${input.name}, updated_at = now() WHERE code = ${code}`;
    if (input.tagline !== undefined) await tx`UPDATE plans SET tagline = ${input.tagline}, updated_at = now() WHERE code = ${code}`;
    if (input.display_order !== undefined) await tx`UPDATE plans SET display_order = ${input.display_order}, updated_at = now() WHERE code = ${code}`;
    if (input.highlighted !== undefined) {
      // só um plano de cada vez fica em destaque na página comercial
      if (input.highlighted) await tx`UPDATE plans SET highlighted = false WHERE code <> ${code}`;
      await tx`UPDATE plans SET highlighted = ${input.highlighted}, updated_at = now() WHERE code = ${code}`;
    }
    if (input.active !== undefined) await tx`UPDATE plans SET active = ${input.active}, updated_at = now() WHERE code = ${code}`;
    if (input.features !== undefined) await tx`UPDATE plans SET features = ${input.features}::text[], updated_at = now() WHERE code = ${code}`;
    if (input.prices !== undefined) await writePrices(tx, code, input.prices);
    await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: 'platform', action: 'platform.plan.update', entityType: 'plan', metadata: { code, fields: Object.keys(input) }, ip: ctx.ip });
    return (await loadPlans(tx)).find((p) => p.code === code)!;
  });
  clearFeatureCache();
  return json({ plan });
}

async function updateSubscription(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
  const input = await ctx.body(SubscriptionUpdateInput);
  const row = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [r] = await tx`SELECT 1 FROM restaurants WHERE id = ${id.data}`;
    if (!r) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
    if (input.plan_code !== undefined) {
      const [p] = await tx`SELECT 1 FROM plans WHERE code = ${input.plan_code}`;
      if (!p) throw new HttpError(422, 'PLAN_NOT_FOUND', 'O plano escolhido não existe.');
    }
    const [cur] = await tx<{ plan_code: string; status: string; valid_until: string | null; notes: string | null }>`
      SELECT plan_code, status, valid_until::text AS valid_until, notes FROM subscriptions WHERE restaurant_id = ${id.data}`;
    const next = {
      plan_code: input.plan_code ?? cur?.plan_code ?? 'starter',
      status: input.status ?? cur?.status ?? 'ativa',
      valid_until: input.valid_until !== undefined ? input.valid_until : cur?.valid_until ?? null,
      notes: input.notes !== undefined ? input.notes : cur?.notes ?? null,
    };
    await tx`
      INSERT INTO subscriptions (restaurant_id, plan_code, status, valid_until, notes)
      VALUES (${id.data}, ${next.plan_code}, ${next.status}, ${next.valid_until}::date, ${next.notes})
      ON CONFLICT (restaurant_id) DO UPDATE SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status,
        valid_until = EXCLUDED.valid_until, notes = EXCLUDED.notes, updated_at = now()`;
    await audit(tx, {
      restaurantId: id.data, actorId: a.userId, actorRole: 'platform', action: 'platform.subscription.update', entityType: 'restaurant', entityId: id.data,
      metadata: { from: cur?.plan_code ?? null, to: next.plan_code, status: next.status, valid_until: next.valid_until }, ip: ctx.ip,
    });
    return next;
  });
  clearFeatureCache();
  return json({ subscription: row });
}

/** Utilização por restaurante: só contagens e espaço usado (nenhum pedido, cliente nem valor de vendas). */
async function usage(ctx: Ctx): Promise<Response> {
  const rows = await ctx.deps.db.as(ctx.dbContext(), (tx) =>
    tx<{ restaurant_id: string; tables_count: number; items_count: number; items_with_3d: number; orders_30d: number; assets_bytes: string; last_order_at: Date | null; staff_count: number }>`
      SELECT * FROM platform_usage()`,
  );
  const out: AdminUsageRow[] = rows.map((r) => ({ ...r, assets_bytes: Number(r.assets_bytes), last_order_at: iso(r.last_order_at) }));
  return json({ usage: out, generated_at: new Date().toISOString(), defaults: DEFAULT_PLANS.map((p) => p.code) });
}

export const billingRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/admin/plans', access: 'platform', handler: listPlans },
  { method: 'POST', path: '/api/admin/plans', access: 'platform', handler: createPlan, limits: [{ name: 'admin-plan', max: 30, windowMs: 60_000 }] },
  { method: 'PATCH', path: '/api/admin/plans/:code', access: 'platform', handler: updatePlan },
  { method: 'PATCH', path: '/api/admin/restaurants/:id/subscription', access: 'platform', handler: updateSubscription },
  { method: 'GET', path: '/api/admin/usage', access: 'platform', handler: usage },
];
