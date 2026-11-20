// Equipa do restaurante (só o gerente): criar contas com palavra-passe temporária, mudar o perfil, desativar e repor palavras-passe.
//
// As contas ficam na tabela "users", a que o perfil do gerente NÃO tem acesso: por isso estas rotas correm em contexto "sistema"
// e filtram SEMPRE pelo restaurante da sessão. Os testes confirmam que um gerente nunca vê nem altera a equipa de outro restaurante.
import { StaffCreateInput, StaffUpdateInput, uuid } from '../../../../shared/schemas';
import type { StaffRole } from '../../../../shared/status';
import type { StaffMember } from '../../../../shared/types';
import { hashPassword } from '../../auth/password';
import { revokeSessionsOfUser } from '../../auth/sessions';
import { iso, pgCode, pgConstraint } from '../../db/client';
import { audit } from '../../lib/audit';
import { temporaryPassword } from '../../lib/crypto';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { created, json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

interface MemberRow {
  user_id: string;
  name: string;
  email: string;
  role: StaffRole;
  active: boolean;
  must_change_password: boolean;
  last_login_at: Date | null;
}

const toView = (r: MemberRow, selfId: string): StaffMember => ({
  user_id: r.user_id,
  name: r.name,
  email: r.email,
  role: r.role,
  active: r.active,
  must_change_password: r.must_change_password,
  last_login_at: iso(r.last_login_at),
  is_self: r.user_id === selfId,
});

async function list(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rows = await ctx.deps.db.system((tx) =>
    tx<MemberRow>`
      SELECT m.user_id, u.name, u.email, m.role, m.active, u.must_change_password, u.last_login_at
      FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${a.restaurantId}
      ORDER BY m.active DESC, CASE m.role WHEN 'manager' THEN 0 WHEN 'waiter' THEN 1 ELSE 2 END, lower(u.name), u.email`,
  );
  return json({ members: rows.map((r) => toView(r, a.userId)) });
}

async function create(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const { db, config } = ctx.deps;
  const input = await ctx.body(StaffCreateInput);

  // o cálculo da palavra-passe é pesado: faz-se antes da transação
  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);
  try {
    const row = await db.system(async (tx) => {
      const [existing] = await tx<{ id: string }>`SELECT id FROM users WHERE email = ${input.email}`;
      if (existing) throw conflict('Já existe uma conta com este e-mail.', 'EMAIL_TAKEN');
      const [u] = await tx<{ id: string }>`
        INSERT INTO users (email, name, password_hash, must_change_password) VALUES (${input.email}, ${input.name}, ${tempHash}, true) RETURNING id`;
      await tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${a.restaurantId}, ${u!.id}, ${input.role})`;
      await audit(tx, {
        restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'staff.create', entityType: 'user', entityId: u!.id,
        metadata: { role: input.role, email: input.email }, ip: ctx.ip,
      });
      const [m] = await tx<MemberRow>`
        SELECT m.user_id, u.name, u.email, m.role, m.active, u.must_change_password, u.last_login_at
        FROM restaurant_members m JOIN users u ON u.id = m.user_id WHERE m.restaurant_id = ${a.restaurantId} AND m.user_id = ${u!.id}`;
      return m!;
    });
    // a palavra-passe temporária só é mostrada agora; a pessoa tem de a trocar no primeiro acesso
    return created({ member: toView(row, a.userId), temporary_password: tempPassword });
  } catch (err) {
    if (pgCode(err) === '23505' && pgConstraint(err) === 'users_email_uq') throw conflict('Já existe uma conta com este e-mail.', 'EMAIL_TAKEN');
    throw err;
  }
}

async function update(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const uid = uuid.safeParse(ctx.params.userId);
  if (!uid.success) throw notFound('Pessoa não encontrada.', 'STAFF_NOT_FOUND');
  if (uid.data === a.userId) throw forbidden('Não pode alterar a sua própria conta. Peça a outro gerente.', 'CANNOT_EDIT_SELF');
  const input = await ctx.body(StaffUpdateInput);

  const row = await ctx.deps.db.system(async (tx) => {
    const [cur] = await tx<MemberRow>`
      SELECT m.user_id, u.name, u.email, m.role, m.active, u.must_change_password, u.last_login_at
      FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${a.restaurantId} AND m.user_id = ${uid.data} FOR UPDATE OF m`;
    if (!cur) throw notFound('Pessoa não encontrada.', 'STAFF_NOT_FOUND');
    const role = input.role ?? cur.role;
    const active = input.active ?? cur.active;
    await tx`UPDATE restaurant_members SET role = ${role}, active = ${active} WHERE restaurant_id = ${a.restaurantId} AND user_id = ${uid.data}`;
    if (!active) {
      // sem acesso imediato: termina as sessões desta pessoa neste restaurante
      await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${uid.data} AND restaurant_id = ${a.restaurantId} AND revoked_at IS NULL`;
    }
    await audit(tx, {
      restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'staff.update', entityType: 'user', entityId: uid.data,
      metadata: { ...(input.role ? { role: { from: cur.role, to: input.role } } : {}), ...(input.active !== undefined ? { active: { from: cur.active, to: input.active } } : {}) },
      ip: ctx.ip,
    });
    return { ...cur, role, active };
  });
  return json({ member: toView(row, a.userId) });
}

/** Nova palavra-passe temporária para um empregado ou cozinha que a esqueceu. */
async function resetPassword(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const { db, config } = ctx.deps;
  const uid = uuid.safeParse(ctx.params.userId);
  if (!uid.success) throw notFound('Pessoa não encontrada.', 'STAFF_NOT_FOUND');
  if (uid.data === a.userId) throw forbidden('Para mudar a sua palavra-passe use "Alterar palavra-passe".', 'CANNOT_EDIT_SELF');

  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);
  const email = await db.system(async (tx) => {
    const [m] = await tx<{ email: string; role: StaffRole; active: boolean }>`
      SELECT u.email, m.role, m.active FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${a.restaurantId} AND m.user_id = ${uid.data}`;
    if (!m) throw notFound('Pessoa não encontrada.', 'STAFF_NOT_FOUND');
    if (!m.active) throw conflict('Esta pessoa está desativada. Ative-a primeiro.', 'STAFF_INACTIVE');
    // a palavra-passe de um gerente repõe-se pela Altiora (evita que um gerente tome a conta de outro)
    if (m.role === 'manager') throw forbidden('A palavra-passe de um gerente é reposta pela Altiora Grupo.', 'MANAGER_RESET_BY_PLATFORM');
    // se a conta também pertence a outro restaurante, repor a palavra-passe daria acesso a esse restaurante
    const [other] = await tx<{ n: number }>`
      SELECT count(*)::int AS n FROM restaurant_members WHERE user_id = ${uid.data} AND restaurant_id <> ${a.restaurantId}`;
    if (other!.n > 0) throw conflict('Esta conta também é usada noutro restaurante. Peça à Altiora Grupo para repor a palavra-passe.', 'SHARED_ACCOUNT');
    await tx`UPDATE users SET password_hash = ${tempHash}, must_change_password = true WHERE id = ${uid.data}`;
    await audit(tx, {
      restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'staff.password_reset', entityType: 'user', entityId: uid.data, ip: ctx.ip,
    });
    return m.email;
  });
  await revokeSessionsOfUser(db, uid.data);
  return json({ email, temporary_password: tempPassword });
}

export const staffRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/staff', access: { roles: ['manager'] }, handler: list },
  { method: 'POST', path: '/api/staff', access: { roles: ['manager'] }, handler: create, limits: [{ name: 'staff-create', max: 30, windowMs: 60_000 }] },
  { method: 'PATCH', path: '/api/staff/:userId', access: { roles: ['manager'] }, handler: update, limits: [{ name: 'staff-update', max: 60, windowMs: 60_000 }] },
  { method: 'POST', path: '/api/staff/:userId/reset-password', access: { roles: ['manager'] }, handler: resetPassword, noBody: true, limits: [{ name: 'staff-reset', max: 20, windowMs: 60_000 }] },
];
