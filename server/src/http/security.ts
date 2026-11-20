// Cabeçalhos de segurança, CORS e proteção contra pedidos forjados entre sites (CSRF).
import { forbidden } from '../lib/errors';

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export function applySecurityHeaders(res: Response, opts: { isProd: boolean; isApi: boolean }): void {
  const h = res.headers;
  const setDefault = (k: string, v: string) => {
    if (!h.has(k)) h.set(k, v);
  };
  setDefault('x-content-type-options', 'nosniff');
  // o endereço do menu contém um segredo da mesa: nunca o enviar a outros sites
  setDefault('referrer-policy', 'no-referrer');
  // as páginas só podem ser incorporadas por páginas do próprio site (a demonstração na página comercial); a API nunca
  setDefault('x-frame-options', opts.isApi ? 'DENY' : 'SAMEORIGIN');
  setDefault('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  setDefault('cross-origin-opener-policy', 'same-origin');
  setDefault('cross-origin-resource-policy', 'same-origin');
  setDefault('content-security-policy', opts.isApi ? API_CSP : HTML_CSP);
  if (opts.isProd) setDefault('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

export interface OriginPolicy {
  allowed: Set<string>;
}

export function buildOriginPolicy(publicBaseUrl: string, extra: string[]): OriginPolicy {
  return { allowed: new Set([publicBaseUrl, ...extra]) };
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** A origem do pedido é o próprio site (mesmo domínio) ou um domínio autorizado? */
export function isAllowedOrigin(origin: string, requestUrl: URL, policy: OriginPolicy): boolean {
  if (policy.allowed.has(origin)) return true;
  return hostOf(origin) === requestUrl.host;
}

/**
 * Pedidos que alteram dados e usam o cookie de sessão só são aceites se vierem do nosso site.
 * (Para além disto, o cookie é SameSite=Lax e a API só aceita JSON.)
 */
export function assertSameOrigin(req: Request, requestUrl: URL, policy: OriginPolicy): void {
  const origin = req.headers.get('origin');
  if (origin) {
    if (!isAllowedOrigin(origin, requestUrl, policy)) throw forbidden('Origem do pedido não autorizada.', 'ORIGIN_NOT_ALLOWED');
    return;
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw forbidden('Origem do pedido não autorizada.', 'ORIGIN_NOT_ALLOWED');
}

const CORS_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';
const CORS_HEADERS = 'Content-Type, Idempotency-Key';

/** Cabeçalhos CORS apenas para origens autorizadas (e diferentes do próprio site). */
export function corsHeaders(req: Request, requestUrl: URL, policy: OriginPolicy): Record<string, string> | null {
  const origin = req.headers.get('origin');
  if (!origin || !policy.allowed.has(origin) || hostOf(origin) === requestUrl.host) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

export function preflightResponse(req: Request, requestUrl: URL, policy: OriginPolicy): Response {
  const cors = corsHeaders(req, requestUrl, policy);
  if (!cors) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      'access-control-allow-methods': CORS_METHODS,
      'access-control-allow-headers': CORS_HEADERS,
      'access-control-max-age': '600',
    },
  });
}
