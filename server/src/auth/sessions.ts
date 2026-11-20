// Sessões de utilizadores da equipa. O token (aleatório, 256 bits) só existe no cookie do navegador;
// na base de dados guarda-se apenas o seu SHA-256.
import type { Config } from '../config';
import type { Database } from '../db/client';
import { randomToken, sha256Hex } from '../lib/crypto';
import type { AuthInfo } from '../http/types';
import type { StaffRole } from '../../../shared/status';

export const SESSION_COOKIE_PLAIN = 'altiora_sid';
export const SESSION_COOKIE_SECURE = '__Host-altiora_sid';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const cookieName = (cfg: Config) => (cfg.cookieSecure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN);

export async function createSession(
  db: Database,
  cfg: Config,
  p: { userId: string; restaurantId: string | null; ip: string; userAgent: string | null },
): Promise<{ token: string; maxAgeSec: number }> {
  const token = randomToken(32);
  const idleSec = cfg.sessionIdleHours * 3600;
  const maxSec = cfg.sessionMaxDays * 86400;
  await db.system(async (tx) => {
    await tx`
      INSERT INTO sessions (user_id, restaurant_id, token_hash, expires_at, absolute_expires_at, ip, user_agent)
      VALUES (${p.userId}, ${p.restaurantId}, ${sha256Hex(token)},
              now() + make_interval(secs => ${idleSec}),
              now() + make_interval(secs => ${maxSec}),
              ${p.ip}, ${(p.userAgent ?? '').slice(0, 300) || null})`;
  });
  return { token, maxAgeSec: maxSec };
}

interface SessionJoin {
  id: string;
  user_id: string;
  restaurant_id: string | null;
  stale: boolean;
  email: string;
  name: string;
  is_platform_admin: boolean;
  user_active: boolean;
  must_change_password: boolean;
  member_role: StaffRole | null;
  member_active: boolean | null;
  restaurant_name: string | null;
  restaurant_slug: string | null;
  restaurant_status: string | null;
}

/** Carrega a sessão a partir do valor do cookie. Devolve null se for inválida, expirada ou revogada. */
export async function loadAuth(db: Database, cfg: Config, token: string): Promise<AuthInfo | null> {
  if (!TOKEN_RE.test(token)) return null;
  const idleSec = cfg.sessionIdleHours * 3600;
  return db.system(async (tx) => {
    const [s] = await tx<SessionJoin>`
      SELECT s.id, s.user_id, s.restaurant_id, (now() - s.last_seen_at) > interval '60 seconds' AS stale,
             u.email, u.name, u.is_platform_admin, u.active AS user_active, u.must_change_password,
             m.role AS member_role, m.active AS member_active,
             r.name AS restaurant_name, r.slug AS restaurant_slug, r.status AS restaurant_status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN restaurant_members m ON m.user_id = s.user_id AND m.restaurant_id = s.restaurant_id
      LEFT JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token_hash = ${sha256Hex(token)} AND s.revoked_at IS NULL
        AND s.expires_at > now() AND s.absolute_expires_at > now()`;
    if (!s || !s.user_active) return null;

    let role: AuthInfo['role'];
    if (s.is_platform_admin) role = 'platform';
    else {
      if (!s.member_role || !s.member_active || !s.restaurant_id) return null;
      role = s.member_role;
    }

    if (s.stale) {
      await tx`
        UPDATE sessions SET last_seen_at = now(),
               expires_at = LEAST(now() + make_interval(secs => ${idleSec}), absolute_expires_at)
        WHERE id = ${s.id}`;
    }
    return {
      sessionId: s.id,
      userId: s.user_id,
      email: s.email,
      name: s.name,
      role,
      mustChangePassword: s.must_change_password,
      restaurantId: s.is_platform_admin ? null : s.restaurant_id,
      restaurantName: s.is_platform_admin ? null : s.restaurant_name,
      restaurantSlug: s.is_platform_admin ? null : s.restaurant_slug,
      restaurantStatus: s.is_platform_admin ? null : s.restaurant_status,
    } satisfies AuthInfo;
  });
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.system(async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now() WHERE id = ${sessionId} AND revoked_at IS NULL`;
  });
}

export async function revokeOtherSessions(db: Database, userId: string, keepSessionId: string): Promise<void> {
  await db.system(async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND id <> ${keepSessionId} AND revoked_at IS NULL`;
  });
}

/** Termina todas as sessões de um utilizador (ex.: após repor a palavra-passe). */
export async function revokeSessionsOfUser(db: Database, userId: string): Promise<void> {
  await db.system(async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
  });
}

export async function purgeExpiredSessions(db: Database): Promise<number> {
  return db.system(async (tx) => {
    const rows = await tx`
      DELETE FROM sessions
      WHERE absolute_expires_at < now() - interval '1 day' OR expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'
      RETURNING id`;
    return rows.length;
  });
}
