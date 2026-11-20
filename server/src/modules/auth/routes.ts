// Início e fim de sessão, perfil e troca de palavra-passe da equipa.
import { ChangePasswordInput, LoginInput, SwitchRestaurantInput } from '../../../../shared/schemas';
import type { StaffRole } from '../../../../shared/status';
import type { SessionUser } from '../../../../shared/types';
import { hashPassword, checkPasswordStrength, verifyPassword } from '../../auth/password';
import { cookieName, createSession, revokeOtherSessions, revokeSession } from '../../auth/sessions';
import type { Database } from '../../db/client';
import { audit } from '../../lib/audit';
import { HttpError, forbidden, tooMany, unprocessable } from '../../lib/errors';
import { restaurantFeatures } from '../../lib/plans';
import { serializeCookie } from '../../http/cookies';
import { json, noContent } from '../../http/respond';
import type { AuthInfo, Ctx, RouteSpec } from '../../http/types';

const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou palavra-passe incorretos.');

// Hash de uma palavra-passe que ninguém usa: serve para que "e-mail inexistente" demore o mesmo que "palavra-passe errada".
let dummyHash: Promise<string> | null = null;
const getDummyHash = (logN: number) => (dummyHash ??= hashPassword('altiora-palavra-passe-que-nunca-e-valida', logN));

interface MembershipRow {
  restaurant_id: string;
  restaurant_name: string;
  role: StaffRole;
  status: string;
}

async function memberships(db: Database, userId: string): Promise<MembershipRow[]> {
  return db.system((tx) =>
    tx<MembershipRow>`
      SELECT m.restaurant_id, r.name AS restaurant_name, m.role, r.status
      FROM restaurant_members m JOIN restaurants r ON r.id = m.restaurant_id
      WHERE m.user_id = ${userId} AND m.active
      ORDER BY (r.status = 'ativo') DESC, r.name`,
  );
}

async function toSessionUser(db: Database, a: AuthInfo): Promise<SessionUser> {
  const list = a.role === 'platform' ? [] : await memberships(db, a.userId);
  const features = a.restaurantId && a.role !== 'platform' ? [...(await restaurantFeatures(db, a.restaurantId))] : [];
  return {
    id: a.userId,
    name: a.name,
    email: a.email,
    role: a.role,
    must_change_password: a.mustChangePassword,
    restaurant: a.restaurantId
      ? { id: a.restaurantId, name: a.restaurantName ?? '', slug: a.restaurantSlug ?? '', status: a.restaurantStatus ?? 'ativo' }
      : null,
    memberships: list.filter((m) => m.status === 'ativo').map((m) => ({ restaurant_id: m.restaurant_id, restaurant_name: m.restaurant_name, role: m.role })),
    features,
  };
}

function sessionCookie(ctx: Ctx, token: string, maxAgeSec: number): string {
  return serializeCookie(cookieName(ctx.deps.config), token, { maxAgeSec, secure: ctx.deps.config.cookieSecure });
}

function clearCookie(ctx: Ctx): string {
  return serializeCookie(cookieName(ctx.deps.config), '', { maxAgeSec: 0, secure: ctx.deps.config.cookieSecure });
}

// --- POST /api/auth/login -----------------------------------------------------------------------
async function login(ctx: Ctx): Promise<Response> {
  const { db, config, loginThrottle, log } = ctx.deps;
  const input = await ctx.body(LoginInput);
  const email = input.email;

  const keyIpEmail = `ip-email:${ctx.ip}|${email}`;
  const keyIp = `ip:${ctx.ip}`;
  const keyEmail = `email:${email}`;
  const wait = Math.max(loginThrottle.check(keyIpEmail, 6), loginThrottle.check(keyIp, 40), loginThrottle.check(keyEmail, 25));
  if (wait > 0) throw tooMany('Demasiadas tentativas de início de sessão. Tente novamente dentro de alguns minutos.', wait, 'LOGIN_LOCKED');

  const user = await db.system(async (tx) => {
    const [u] = await tx<{
      id: string; email: string; name: string; password_hash: string; is_platform_admin: boolean; active: boolean; must_change_password: boolean;
    }>`SELECT id, email, name, password_hash, is_platform_admin, active, must_change_password FROM users WHERE email = ${email}`;
    return u ?? null;
  });

  const ok = user ? await verifyPassword(input.password, user.password_hash) : (await verifyPassword(input.password, await getDummyHash(config.scryptLogN)), false);
  if (!user || !user.active || !ok) {
    loginThrottle.fail(keyIpEmail);
    loginThrottle.fail(keyIp);
    loginThrottle.fail(keyEmail);
    if (user) {
      await db.system((tx) =>
        audit(tx, { restaurantId: null, actorId: user.id, actorRole: null, action: 'auth.login_failed', entityType: 'user', entityId: user.id, ip: ctx.ip }),
      );
    }
    log.info('início de sessão recusado', { request_id: ctx.requestId });
    throw invalidCredentials();
  }
  loginThrottle.success(keyIpEmail);
  loginThrottle.success(keyEmail);

  // Escolhe o restaurante: o primeiro cuja conta esteja ativa
  let restaurantId: string | null = null;
  let role: StaffRole | 'platform' = 'platform';
  if (!user.is_platform_admin) {
    const list = await memberships(db, user.id);
    const usable = list.find((m) => m.status === 'ativo');
    if (!usable) {
      throw list.length
        ? new HttpError(403, 'RESTAURANT_SUSPENDED', 'A conta do restaurante está suspensa. Contacte a Altiora Grupo.')
        : new HttpError(403, 'NO_MEMBERSHIP', 'Esta conta não está associada a nenhum restaurante. Contacte o gerente.');
    }
    restaurantId = usable.restaurant_id;
    role = usable.role;
  }

  const { token, maxAgeSec } = await createSession(db, config, {
    userId: user.id,
    restaurantId,
    ip: ctx.ip,
    userAgent: ctx.req.headers.get('user-agent'),
  });
  const rest = await db.system(async (tx) => {
    await tx`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;
    await audit(tx, {
      restaurantId, actorId: user.id, actorRole: role, action: user.is_platform_admin ? 'platform.login' : 'auth.login',
      entityType: 'user', entityId: user.id, ip: ctx.ip,
    });
    if (!restaurantId) return null;
    return (await tx<{ id: string; name: string; slug: string; status: string }>`SELECT id, name, slug, status FROM restaurants WHERE id = ${restaurantId}`)[0] ?? null;
  });
  const auth: AuthInfo = {
    sessionId: '',
    userId: user.id,
    email: user.email,
    name: user.name,
    role,
    mustChangePassword: user.must_change_password,
    restaurantId,
    restaurantName: rest?.name ?? null,
    restaurantSlug: rest?.slug ?? null,
    restaurantStatus: rest?.status ?? null,
  };
  return json({ user: await toSessionUser(db, auth) }, 200, { 'set-cookie': sessionCookie(ctx, token, maxAgeSec) });
}

// --- GET /api/auth/me ---------------------------------------------------------------------------
async function me(ctx: Ctx): Promise<Response> {
  return json({ user: await toSessionUser(ctx.deps.db, ctx.auth!) });
}

// --- POST /api/auth/logout ----------------------------------------------------------------------
async function logout(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  await revokeSession(ctx.deps.db, a.sessionId);
  return noContent({ 'set-cookie': clearCookie(ctx) });
}

// --- POST /api/auth/change-password -------------------------------------------------------------
async function changePassword(ctx: Ctx): Promise<Response> {
  const { db, config, limiter } = ctx.deps;
  const a = ctx.auth!;
  const input = await ctx.body(ChangePasswordInput);

  const lim = limiter.hit(`chpw:${a.userId}`, 6, 60_000);
  if (!lim.ok) throw tooMany('Demasiadas tentativas. Aguarde um momento.', lim.retryAfterSec);

  const stored = await db.system(async (tx) => (await tx<{ password_hash: string }>`SELECT password_hash FROM users WHERE id = ${a.userId}`)[0]);
  if (!stored || !(await verifyPassword(input.current_password, stored.password_hash))) {
    throw unprocessable('A palavra-passe atual está incorreta.', 'WRONG_CURRENT_PASSWORD');
  }
  const weak = checkPasswordStrength(input.new_password, a.email);
  if (weak) throw unprocessable(weak, 'WEAK_PASSWORD');
  if (input.new_password === input.current_password) throw unprocessable('A nova palavra-passe tem de ser diferente da atual.', 'SAME_PASSWORD');

  const hash = await hashPassword(input.new_password, config.scryptLogN);
  await db.system(async (tx) => {
    await tx`UPDATE users SET password_hash = ${hash}, must_change_password = false WHERE id = ${a.userId}`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: a.role === 'platform' ? 'platform.password_changed' : 'auth.password_changed', entityType: 'user', entityId: a.userId, ip: ctx.ip });
  });
  // as outras sessões (outros telemóveis/computadores) deixam de ser válidas
  await revokeOtherSessions(db, a.userId, a.sessionId);
  return noContent();
}

// --- POST /api/auth/switch-restaurant -----------------------------------------------------------
async function switchRestaurant(ctx: Ctx): Promise<Response> {
  const { db } = ctx.deps;
  const a = ctx.auth!;
  if (a.role === 'platform') throw forbidden('Esta conta não pertence a restaurantes.', 'FORBIDDEN');
  const input = await ctx.body(SwitchRestaurantInput);
  const target = (await memberships(db, a.userId)).find((m) => m.restaurant_id === input.restaurant_id && m.status === 'ativo');
  if (!target) throw forbidden('Não pertence a esse restaurante.', 'NOT_A_MEMBER');
  const rest = await db.system(async (tx) => {
    await tx`UPDATE sessions SET restaurant_id = ${target.restaurant_id} WHERE id = ${a.sessionId}`;
    return (await tx<{ id: string; name: string; slug: string; status: string }>`SELECT id, name, slug, status FROM restaurants WHERE id = ${target.restaurant_id}`)[0]!;
  });
  const next: AuthInfo = { ...a, role: target.role, restaurantId: rest.id, restaurantName: rest.name, restaurantSlug: rest.slug, restaurantStatus: rest.status };
  return json({ user: await toSessionUser(db, next) });
}

export const authRoutes: RouteSpec[] = [
  { method: 'POST', path: '/api/auth/login', access: 'public', handler: login, limits: [{ name: 'login', max: 30, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/auth/me', access: 'session', handler: me, allowSuspended: true, allowMustChange: true },
  { method: 'POST', path: '/api/auth/logout', access: 'session', handler: logout, allowSuspended: true, allowMustChange: true, noBody: true },
  { method: 'POST', path: '/api/auth/change-password', access: 'session', handler: changePassword, allowSuspended: true, allowMustChange: true },
  { method: 'POST', path: '/api/auth/switch-restaurant', access: 'session', handler: switchRestaurant, allowSuspended: true },
];
