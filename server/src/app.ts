// Aplicação HTTP: recebe um Request e devolve um Response (sem depender de rede, o que permite testá-la diretamente).
//
// Ordem de cada pedido à API:
//  1. identificar o pedido e o IP;  2. encontrar a rota;  3. limites de pedidos por IP;
//  4. sessão e permissões (perfil, restaurante suspenso, palavra-passe temporária, origem do pedido);
//  5. executar a rota;  6. converter qualquer erro numa resposta segura;  7. cabeçalhos de segurança e registo.
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { cookieName, loadAuth } from './auth/sessions';
import type { DbContext, DbRole } from './db/client';
import { readBytesBody, readJsonBody } from './http/body';
import { clientIp } from './http/client-ip';
import { parseCookies, serializeCookie } from './http/cookies';
import { mapError } from './http/errors-map';
import { Router } from './http/router';
import { applySecurityHeaders, assertSameOrigin, corsHeaders, preflightResponse } from './http/security';
import { serveStatic } from './http/static';
import type { AuthInfo, Ctx, Deps } from './http/types';
import { HttpError, forbidden, tooMany, unauthorized } from './lib/errors';
import { installZodPt, zodDetails } from './lib/zod-pt';
import { allRoutes } from './modules';
import { createSite } from './site/site';

export interface FetchInfo {
  /** IP da ligação (o do proxy, se houver). */
  ip?: string;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

function errorResponse(err: HttpError, requestId: string): Response {
  const body = { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) }, request_id: requestId };
  return new Response(JSON.stringify(body), {
    status: err.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...err.headers },
  });
}

export function createApp(deps: Deps) {
  installZodPt();
  const { config, log, limiter } = deps;
  const router = new Router();
  router.addAll(allRoutes);
  const sidCookie = cookieName(config);
  const site = createSite(deps);

  const clearSessionCookie = () => serializeCookie(sidCookie, '', { maxAgeSec: 0, secure: config.cookieSecure });

  async function handleApi(req: Request, url: URL, ip: string, requestId: string, setRoute: (label: string) => void): Promise<Response> {
    if (req.method === 'OPTIONS') return preflightResponse(req, url, deps.origins);
    if (url.pathname.length > 512) throw new HttpError(414, 'URI_TOO_LONG', 'Endereço demasiado longo.');

    const match = router.match(req.method, url.pathname);
    if (match.kind === 'none') throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Endereço não encontrado.');
    if (match.kind === 'method') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.', undefined, { allow: match.allow.join(', ') });
    const { route, params } = match;
    setRoute(`${route.method} ${route.path}`);

    // limites por IP (geral e da própria rota)
    const general = limiter.hit(`ip:${ip}`, 1500, 60_000);
    if (!general.ok) throw tooMany('Demasiados pedidos. Aguarde um momento e tente novamente.', general.retryAfterSec);
    for (const rule of route.limits ?? []) {
      const r = limiter.hit(`${rule.name}:${ip}`, rule.max, rule.windowMs);
      if (!r.ok) throw tooMany('Demasiados pedidos. Aguarde um momento e tente novamente.', r.retryAfterSec);
    }

    // sessão e permissões
    let auth: AuthInfo | null = null;
    if (route.access !== 'public') {
      // pedidos que alteram dados só são aceites se vierem do nosso próprio site
      if (req.method !== 'GET' && req.method !== 'HEAD') assertSameOrigin(req, url, deps.origins);

      const token = parseCookies(req.headers.get('cookie'))[sidCookie];
      if (!token) throw unauthorized();
      auth = await loadAuth(deps.db, config, token);
      if (!auth) {
        throw new HttpError(401, 'SESSION_EXPIRED', 'A sua sessão terminou. Inicie sessão novamente.', undefined, { 'set-cookie': clearSessionCookie() });
      }

      if (route.access === 'platform') {
        if (auth.role !== 'platform') throw forbidden();
      } else if (route.access !== 'session') {
        if (auth.role === 'platform' || !route.access.roles.includes(auth.role)) throw forbidden();
      }
      if (auth.role !== 'platform' && auth.restaurantStatus !== 'ativo' && !route.allowSuspended) {
        throw new HttpError(403, 'RESTAURANT_SUSPENDED', 'A conta do restaurante está suspensa. Contacte a Altiora Grupo.');
      }
      if (auth.mustChangePassword && !route.allowMustChange) {
        throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Tem de definir uma nova palavra-passe antes de continuar.');
      }
    }

    let bodyPromise: Promise<unknown> | null = null;
    const ctx: Ctx = {
      req,
      url,
      params,
      ip,
      requestId,
      deps,
      auth,
      bytes(maxBytes: number): Promise<Uint8Array> {
        return readBytesBody(req, maxBytes);
      },
      async body<T>(schema: ZodType<T, any, any>): Promise<T> {
        bodyPromise ??= readJsonBody(req);
        const parsed = schema.safeParse(await bodyPromise);
        if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos.', zodDetails(parsed.error));
        return parsed.data;
      },
      dbContext(extra: Partial<DbContext> = {}): DbContext {
        if (!auth) throw new Error('dbContext() só pode ser usado em rotas autenticadas');
        return { role: auth.role as DbRole, restaurantId: auth.restaurantId, userId: auth.userId, ...extra };
      },
    };
    return route.handler(ctx);
  }

  async function handle(req: Request, info: FetchInfo = {}): Promise<Response> {
    const started = performance.now();
    const supplied = req.headers.get('x-request-id');
    const requestId = supplied && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
    const ip = clientIp(req, info.ip, config.trustProxyHops);

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response('Pedido inválido', { status: 400 });
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    let routeLabel = isApi ? 'api (sem rota)' : 'site';
    let res: Response;
    try {
      if (isApi) res = await handleApi(req, url, ip, requestId, (l) => (routeLabel = l));
      else res = (await site(req, url, ip)) ?? (await serveStatic(req, url, config.webDir));
    } catch (err) {
      const { error, serverFault } = mapError(err);
      if (serverFault) log.error('erro ao tratar o pedido', { request_id: requestId, route: routeLabel, err });
      res = errorResponse(error, requestId);
    }

    // cabeçalhos comuns
    try {
      applySecurityHeaders(res, { isProd: config.isProd, isApi });
      res.headers.set('x-request-id', requestId);
      // só a página comercial, o aviso de privacidade e o cardápio de demonstração podem aparecer nas pesquisas
      if (!res.headers.has('x-robots-tag')) res.headers.set('x-robots-tag', 'noindex, nofollow');
      if (isApi) {
        const cors = corsHeaders(req, url, deps.origins);
        if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      }
    } catch {
      // respostas imutáveis (não deviam existir aqui): seguem como estão
    }

    const ms = Math.round(performance.now() - started);
    const fields = { request_id: requestId, method: req.method, route: routeLabel, status: res.status, ms, ip };
    if (routeLabel === 'GET /api/health' || routeLabel === 'site') log.debug('pedido', fields);
    else if (res.status >= 500) log.error('pedido', fields);
    else log.info('pedido', fields);

    if (req.method === 'HEAD') return new Response(null, { status: res.status, headers: res.headers });
    return res;
  }

  return { fetch: handle, router };
}

export type App = ReturnType<typeof createApp>;
