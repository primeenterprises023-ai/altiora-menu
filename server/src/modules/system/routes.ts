// Verificação de saúde do serviço e ligação em tempo real da equipa.
import type { StaffRole } from '../../../../shared/status';
import { tooMany } from '../../lib/errors';
import { json } from '../../http/respond';
import { sseResponse } from '../../http/sse';
import type { Ctx, RouteSpec } from '../../http/types';

const staffRoles: ReadonlyArray<StaffRole> = ['manager', 'waiter', 'kitchen'];

// resultado da última verificação (2 s), para que um excesso de pedidos a /api/health não sobrecarregue a base de dados
const healthCache = new WeakMap<object, { at: number; ok: boolean }>();

/** Usada pelo serviço de alojamento (e por quem monitoriza) para saber se a aplicação e a base de dados respondem. */
async function health(ctx: Ctx): Promise<Response> {
  const now = Date.now();
  let cached = healthCache.get(ctx.deps.db);
  if (!cached || now - cached.at > 2_000) {
    cached = { at: now, ok: await ctx.deps.db.ping() };
    healthCache.set(ctx.deps.db, cached);
  }
  const body = {
    status: cached.ok ? 'ok' : 'degraded',
    database: cached.ok ? 'ok' : 'indisponível',
    version: ctx.deps.config.version,
    time: new Date(now).toISOString(),
  };
  return json(body, cached.ok ? 200 : 503);
}

const MAX_STAFF_STREAMS_PER_USER = 8;

/** Avisos em tempo real para os painéis (novo pedido, mudança de estado, menu alterado). */
function staffStream(ctx: Ctx): Response {
  const a = ctx.auth!;
  const release = ctx.deps.hub.acquireSlot(`staff-sse:${a.userId}`, MAX_STAFF_STREAMS_PER_USER);
  if (!release) throw tooMany('Há demasiados painéis abertos com esta conta.', 30, 'TOO_MANY_STREAMS');
  const rid = a.restaurantId!;
  return sseResponse(ctx.req, {
    hello: { type: 'hello', at: new Date().toISOString() },
    subscribe: (send) => ctx.deps.hub.subscribeRestaurant(rid, send),
    // a ligação é renovada de tempos a tempos, o que também revalida a sessão
    maxLifetimeMs: 15 * 60_000,
    onClose: release,
  });
}

export const systemRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/health', access: 'public', handler: health, limits: [{ name: 'health', max: 120, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/realtime/stream', access: { roles: staffRoles }, handler: staffStream, limits: [{ name: 'staff-stream', max: 60, windowMs: 60_000 }] },
];
