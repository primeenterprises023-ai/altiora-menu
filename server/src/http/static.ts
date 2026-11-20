// Entrega da aplicação web já construída (pasta dist/web).
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

interface CacheEntry {
  mtimeMs: number;
  body: Uint8Array;
  br?: Uint8Array;
  gz?: Uint8Array;
}

const cache = new Map<string, CacheEntry>();

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

async function load(path: string): Promise<CacheEntry | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  const entry: CacheEntry = {
    mtimeMs: st.mtimeMs,
    body: new Uint8Array(await readFile(path)),
    br: await readOptional(path + '.br'),
    gz: await readOptional(path + '.gz'),
  };
  if (cache.size > 500) cache.clear();
  cache.set(path, entry);
  return entry;
}

function cacheControl(rel: string): string {
  if (rel.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (rel === '/index.html') return 'no-cache';
  return 'public, max-age=3600';
}

export async function serveStatic(req: Request, url: URL, webDir: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Método não permitido', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Pedido inválido', { status: 400 });
  }
  if (pathname.includes('\0')) return new Response('Pedido inválido', { status: 400 });

  const root = resolve(webDir);
  const rel = normalize(pathname).replace(/\\/g, '/');
  let target = resolve(join(root, rel));
  if (target !== root && !target.startsWith(root + sep)) return new Response('Não encontrado', { status: 404 });

  let relPath = rel === '/' ? '/index.html' : rel;
  let entry = await load(target === root ? join(root, 'index.html') : target);

  if (!entry) {
    // páginas da aplicação (ex.: /menu/abc, /cozinha) → index.html; ficheiros com extensão em falta → 404
    if (extname(rel) !== '') return new Response('Não encontrado', { status: 404 });
    relPath = '/index.html';
    target = join(root, 'index.html');
    entry = await load(target);
    if (!entry) return new Response('A aplicação web ainda não foi construída (execute: bun run build).', { status: 503 });
  }

  const ext = extname(relPath === '/index.html' ? 'x.html' : target);
  const headers: Record<string, string> = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': cacheControl(relPath),
    vary: 'Accept-Encoding',
  };
  const accept = req.headers.get('accept-encoding') ?? '';
  let body = entry.body;
  if (entry.br && /\bbr\b/.test(accept)) {
    body = entry.br;
    headers['content-encoding'] = 'br';
  } else if (entry.gz && /\bgzip\b/.test(accept)) {
    body = entry.gz;
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = String(body.byteLength);
  return new Response(req.method === 'HEAD' ? null : (body as unknown as BodyInit), { status: 200, headers });
}
