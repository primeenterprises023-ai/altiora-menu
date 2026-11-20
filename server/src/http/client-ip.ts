const IP_CHARS = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Descobre o IP do cliente.
 * Atrás de um proxy (Render, Cloudflare...) o IP real vem em X-Forwarded-For. Como o cliente pode
 * enviar esse cabeçalho com valores inventados, só se confia nos "saltos" dos proxies conhecidos:
 * com TRUST_PROXY_HOPS=1 usa-se a última entrada (a que o primeiro proxy acrescentou).
 */
export function clientIp(req: Request, socketIp: string | undefined, hops: number): string {
  const fallback = socketIp && IP_CHARS.test(socketIp) ? socketIp : 'unknown';
  if (hops <= 0) return fallback;
  const header = req.headers.get('x-forwarded-for');
  if (!header) return fallback;
  const parts = header.split(',').map((s) => s.trim()).filter(Boolean);
  const candidate = parts[parts.length - hops] ?? parts[0];
  return candidate && IP_CHARS.test(candidate) ? candidate : fallback;
}
