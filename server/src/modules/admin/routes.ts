// Administração da plataforma (Altiora Grupo): criar e suspender restaurantes, repor palavras-passe de gerentes.
// A conta de plataforma NÃO tem acesso a pedidos, menus, mesas, pagamentos nem à equipa dos restaurantes:
// só vê os dados de contacto mínimos do gerente (nome e e-mail) e o estado do restaurante.
import { AdminCreateRestaurantInput, AdminUpdateRestaurantInput, uuid } from '../../../../shared/schemas';
import type { AdminRestaurant } from '../../../../shared/types';
import { hashPassword } from '../../auth/password';
import { revokeSessionsOfUser } from '../../auth/sessions';
import { iso, pgCode, pgConstraint } from '../../db/client';
import { updatePartial } from '../../db/dynamic';
import { audit } from '../../lib/audit';
import { temporaryPassword, randomToken } from '../../lib/crypto';
import { HttpError, conflict, notFound } from '../../lib/errors';
import { slugify } from '../../lib/slug';
import { created, json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

interface RestaurantRow {
  id: string;
  name: string;
  slug: string;
  status: 'ativo' | 'suspenso' | 'desativado';
  created_at: Date;
  menu_base_url: string | null;
  currency: string;
  is_demo: boolean;
  plan_code: string | null;
  subscription_status: 'ativa' | 'em_atraso' | 'cancelada' | null;
  valid_until: string | null;
  subscription_notes: string | null;
  managers: Array<{ id: string; name: string; email: string }> | null;
}

const toView = (r: RestaurantRow): AdminRestaurant => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  status: r.status,
  created_at: iso(r.created_at)!,
  menu_base_url: r.menu_base_url,
  currency: r.currency,
  is_demo: r.is_demo,
  plan_code: r.plan_code,
  subscription_status: r.subscription_status,
  valid_until: r.valid_until,
  subscription_notes: r.subscription_notes,
  managers: r.managers ?? [],
});

const SELECT_RESTAURANT = `
  SELECT r.id, r.name, r.slug, r.status, r.created_at, r.menu_base_url, r.currency, r.is_demo,
         s.plan_code, s.status AS subscription_status, s.valid_until::text AS valid_until, s.notes AS subscription_notes,`;

async function list(ctx: Ctx): Promise<Response> {
  const rows = await ctx.deps.db.system((tx) =>
    tx.unsafe<RestaurantRow>(`${SELECT_RESTAURANT}
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) ORDER BY m.created_at), '[]'::jsonb)
              FROM restaurant_members m JOIN users u ON u.id = m.user_id
              WHERE m.restaurant_id = r.id AND m.role = 'manager' AND m.active) AS managers
      FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id ORDER BY r.created_at DESC`),
  );
  return json({ restaurants: rows.map(toView) });
}

async function createRestaurant(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const { db, config } = ctx.deps;
  const input = await ctx.body(AdminCreateRestaurantInput);
  const explicitSlug = input.slug !== undefined;
  const baseSlug = input.slug ?? slugify(input.name);

  // A palavra-passe temporária é calculada antes da transação (o cálculo é pesado)
  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);

  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = attempt === 0 ? baseSlug : attempt < 5 ? `${baseSlug.slice(0, 54)}-${attempt + 1}` : `${baseSlug.slice(0, 50)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    try {
      const out = await db.system(async (tx) => {
        const planCode = input.plan_code ?? 'pro';
        const [plan] = await tx<{ code: string }>`SELECT code FROM plans WHERE code = ${planCode} AND active`;
        if (!plan) throw new HttpError(422, 'PLAN_NOT_FOUND', 'O plano escolhido não existe ou já não está disponível.');
        const [r] = await tx<{ id: string }>`INSERT INTO restaurants (name, slug, currency) VALUES (${input.name}, ${slug}, ${input.currency ?? 'AOA'}) RETURNING id`;
        const restaurantId = r!.id;
        await tx`INSERT INTO subscriptions (restaurant_id, plan_code) VALUES (${restaurantId}, ${planCode})`;

        const [existing] = await tx<{ id: string; is_platform_admin: boolean; name: string }>`
          SELECT id, is_platform_admin, name FROM users WHERE email = ${input.manager.email}`;
        let userId: string;
        let existingAccount = false;
        if (existing) {
          if (existing.is_platform_admin) throw conflict('Este e-mail pertence a uma conta de administração da plataforma.', 'EMAIL_IS_PLATFORM_ADMIN');
          userId = existing.id;
          existingAccount = true;
        } else {
          const [u] = await tx<{ id: string }>`
            INSERT INTO users (email, name, password_hash, must_change_password)
            VALUES (${input.manager.email}, ${input.manager.name}, ${tempHash}, true) RETURNING id`;
          userId = u!.id;
        }
        await tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${restaurantId}, ${userId}, 'manager')`;
        await audit(tx, {
          restaurantId, actorId: a.userId, actorRole: 'platform', action: 'platform.restaurant.create', entityType: 'restaurant', entityId: restaurantId,
          metadata: { slug, manager_email: input.manager.email, existing_account: existingAccount, plan: planCode }, ip: ctx.ip,
        });
        const [row] = await tx.unsafe<RestaurantRow>(`${SELECT_RESTAURANT} NULL::jsonb AS managers FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id WHERE r.id = $1`, [restaurantId]);
        return { row: row!, userId, existingAccount };
      });
      return created({
        restaurant: { ...toView(out.row), managers: [{ id: out.userId, name: input.manager.name, email: input.manager.email }] },
        manager: {
          email: input.manager.email,
          existing_account: out.existingAccount,
          // só é mostrada uma vez; o gerente tem de a trocar no primeiro acesso
          temporary_password: out.existingAccount ? null : tempPassword,
        },
      });
    } catch (err) {
      if (pgCode(err) === '23505' && pgConstraint(err) === 'restaurants_slug_uq') {
        if (explicitSlug) throw conflict('Este endereço (slug) já está em uso por outro restaurante.', 'SLUG_TAKEN');
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(409, 'SLUG_TAKEN', 'Não foi possível gerar um endereço único para o restaurante. Indique um manualmente.');
}

async function updateRestaurant(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
  const input = await ctx.body(AdminUpdateRestaurantInput);
  const row = await ctx.deps.db.system(async (tx) => {
    const r = await updatePartial<{ id: string }>(tx, 'restaurants', {
      columns: ['status', 'name'],
      where: 'id = $1',
      whereParams: [id.data],
      returning: 'id',
    }, input);
    if (!r) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
    await audit(tx, {
      restaurantId: id.data, actorId: a.userId, actorRole: 'platform', action: 'platform.restaurant.update', entityType: 'restaurant', entityId: id.data,
      metadata: { ...(input.status ? { status: input.status } : {}), ...(input.name ? { renamed: true } : {}) }, ip: ctx.ip,
    });
    const [full] = await tx.unsafe<RestaurantRow>(`${SELECT_RESTAURANT}
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) ORDER BY m.created_at), '[]'::jsonb)
              FROM restaurant_members m JOIN users u ON u.id = m.user_id
              WHERE m.restaurant_id = r.id AND m.role = 'manager' AND m.active) AS managers
      FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id WHERE r.id = $1`, [id.data]);
    return full!;
  });
  return json({ restaurant: toView(row) });
}

/** Gera uma nova palavra-passe temporária para um gerente (quando se esquece da sua). */
async function resetManagerPassword(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const { db, config } = ctx.deps;
  const rid = uuid.safeParse(ctx.params.id);
  const uid = uuid.safeParse(ctx.params.userId);
  if (!rid.success || !uid.success) throw notFound('Gerente não encontrado.', 'MANAGER_NOT_FOUND');

  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);
  const email = await db.system(async (tx) => {
    const [m] = await tx<{ email: string }>`
      SELECT u.email FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${rid.data} AND m.user_id = ${uid.data} AND m.role = 'manager' AND m.active`;
    if (!m) throw notFound('Gerente não encontrado.', 'MANAGER_NOT_FOUND');
    await tx`UPDATE users SET password_hash = ${tempHash}, must_change_password = true WHERE id = ${uid.data}`;
    await audit(tx, {
      restaurantId: rid.data, actorId: a.userId, actorRole: 'platform', action: 'platform.manager.password_reset', entityType: 'user', entityId: uid.data, ip: ctx.ip,
    });
    return m.email;
  });
  await revokeSessionsOfUser(db, uid.data);
  return json({ manager: { email, temporary_password: tempPassword } });
}

/** Últimas ações de administração da plataforma. */
async function platformAudit(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rows = await ctx.deps.db.as({ role: 'platform', userId: a.userId }, (tx) =>
    tx<{ id: string; restaurant_id: string | null; action: string; metadata: unknown; created_at: Date }>`
      SELECT id, restaurant_id, action, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT 100`,
  );
  return json({ entries: rows.map((r) => ({ id: String(r.id), restaurant_id: r.restaurant_id, action: r.action, metadata: r.metadata, created_at: iso(r.created_at) })) });
}

export const adminRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/admin/restaurants', access: 'platform', handler: list },
  { method: 'POST', path: '/api/admin/restaurants', access: 'platform', handler: createRestaurant, limits: [{ name: 'admin-create', max: 20, windowMs: 60_000 }] },
  { method: 'PATCH', path: '/api/admin/restaurants/:id', access: 'platform', handler: updateRestaurant },
  { method: 'POST', path: '/api/admin/restaurants/:id/managers/:userId/reset-password', access: 'platform', handler: resetManagerPassword, noBody: true, limits: [{ name: 'admin-reset', max: 20, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/admin/audit', access: 'platform', handler: platformAudit },
];
