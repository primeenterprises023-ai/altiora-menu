// Comportamento geral do servidor HTTP: erros seguros, cabeçalhos de proteção, CORS e pedidos forjados (CSRF),
// leitura do corpo, entrega do site, verificação de saúde, limites de pedidos e registos sem dados sensíveis.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { createLogger } from '../src/lib/log';
import { Client, ORIGIN, PASSWORD, orderBody, seedFullRestaurant, startTestApp, uniqueKey, type TestApp } from './helpers';

const INDEX_HTML = '<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>Altiora</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
const APP_JS = 'console.log("Olá, Luanda!");\n'.repeat(60);

let tmp: string;
let webDir: string;
let t: TestApp;
let F: Awaited<ReturnType<typeof seedFullRestaurant>>;
let manager: Client;
let anon: Client;
const logLines: string[] = [];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'altiora-http-'));
  webDir = join(tmp, 'web');
  await mkdir(join(webDir, 'assets'), { recursive: true });
  await mkdir(join(tmp, 'web-private'), { recursive: true });
  await writeFile(join(webDir, 'index.html'), INDEX_HTML);
  await writeFile(join(webDir, 'assets', 'app.js'), APP_JS);
  await writeFile(join(webDir, 'assets', 'app.js.br'), brotliCompressSync(Buffer.from(APP_JS)));
  await writeFile(join(webDir, 'assets', 'app.js.gz'), gzipSync(Buffer.from(APP_JS)));
  await writeFile(join(webDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(tmp, 'segredo.txt'), 'CONTEUDO-PRIVADO');
  await writeFile(join(tmp, 'web-private', 'dados.txt'), 'CONTEUDO-PRIVADO');

  t = await startTestApp({ log: createLogger('debug', (l) => logLines.push(l)), env: { WEB_DIR: webDir } });
  F = await seedFullRestaurant(t, 'Http', 'h');
  manager = await t.login(F.emails.manager, PASSWORD, '203.0.113.50');
  anon = t.anon('203.0.113.51');
});
afterAll(async () => {
  await t.close();
  await rm(tmp, { recursive: true, force: true });
});

const directive = (csp: string | null, name: string) => (csp ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ') || s === name);

describe('erros e identificação dos pedidos', () => {
  test('rotas inexistentes e métodos errados respondem em JSON, sem pistas técnicas', async () => {
    const nf = await anon.get('/api/nao-existe');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(nf.body.error.message).toBe('Endereço não encontrado.');
    expect(nf.body.request_id).toBeTruthy();
    expect(nf.headers.get('content-type')).toContain('application/json');

    const m = await anon.request('DELETE', '/api/health');
    expect(m.status).toBe(405);
    expect(m.body.error.code).toBe('METHOD_NOT_ALLOWED');
    expect(m.headers.get('allow')).toContain('GET');

    const long = await anon.get('/api/' + 'a'.repeat(600));
    expect(long.status).toBe(414);
    expect(long.body.error.code).toBe('URI_TOO_LONG');
  });

  test('cada resposta tem um identificador de pedido; um identificador enviado válido é aproveitado, um inválido é substituído', async () => {
    const r1 = await anon.get('/api/health');
    expect(r1.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const r2 = await anon.get('/api/health', { headers: { 'x-request-id': 'pedido-12345678' } });
    expect(r2.headers.get('x-request-id')).toBe('pedido-12345678');
    const r3 = await anon.get('/api/nada', { headers: { 'x-request-id': 'mau id <script>' } });
    expect(r3.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(r3.body.request_id).toBe(r3.headers.get('x-request-id'));
  });

  test('um erro inesperado devolve uma mensagem genérica; os pormenores só ficam (sem palavras-passe) nos registos', async () => {
    t.app.router.add({
      method: 'GET',
      path: '/api/test/boom',
      access: 'public',
      handler: () => {
        throw new Error('falha a ligar a postgres://altiora:SuperSecreta@db.interno:5432/prod (password=OutraSecreta)');
      },
    });
    const r = await anon.get('/api/test/boom');
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Ocorreu um erro inesperado. Tente novamente.' });
    expect(JSON.stringify(r.body)).not.toMatch(/SuperSecreta|OutraSecreta|postgres|db\.interno/);
    expect(r.body.request_id).toBe(r.headers.get('x-request-id'));
    expect(r.headers.get('cache-control')).toBe('no-store');

    const entry = logLines.map((l) => JSON.parse(l)).find((e) => e.level === 'error' && e.request_id === r.body.request_id);
    expect(entry).toBeTruthy();
    expect(entry.route).toBe('GET /api/test/boom');
    expect(JSON.stringify(entry)).not.toMatch(/SuperSecreta|OutraSecreta/);
    expect(entry.err.message).toContain('postgres://***@db.interno');
  });

  test('erros da base de dados chegam ao cliente como códigos claros em português', async () => {
    // número de mesa repetido → 409 DUPLICATE com mensagem específica
    await manager.post('/api/tables', { table_number: 77 });
    const dup = await manager.post('/api/tables', { table_number: 77 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toEqual({ code: 'DUPLICATE', message: 'Já existe uma mesa com este número.' });
    // identificador que não é UUID → nunca um erro 500
    const bad = await manager.patch('/api/menu/items/isto-nao-e-um-uuid', { name: 'xx' });
    expect(bad.status).toBe(404);
  });
});

describe('cabeçalhos de segurança', () => {
  test('a API não pode ser incorporada nem interpretada como página, e nunca fica em cache', async () => {
    const r = await anon.get('/api/health');
    const h = r.headers;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', database: 'ok' });
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('referrer-policy')).toBe('no-referrer');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(h.get('cache-control')).toBe('no-store');
    expect(h.get('x-robots-tag')).toContain('noindex');
    expect(h.get('permissions-policy')).toContain('camera=()');
    expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(h.get('strict-transport-security')).toBeNull(); // só em produção (HTTPS)
  });

  test('as páginas só executam programas do próprio site (sem scripts embutidos) e não enviam o endereço do menu a terceiros', async () => {
    const r = await anon.get('/menu/Zm9vYmFyMTIzNDU2Nzg5MA');
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy');
    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'self'"); // só o próprio site pode incorporar as páginas (demonstração na página comercial)
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' blob: data:"); // blob:/data: só para o visualizador 3D ler as texturas embutidas no modelo
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  test('em produção: HSTS ativo e cookie de sessão "__Host-" seguro, sem domínio', async () => {
    const p = await startTestApp({ env: { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://menu.altiora.test', COOKIE_SECURE: '', WEB_DIR: webDir } }); // COOKIE_SECURE vazio = valor por omissão (seguro em produção)
    try {
      const f = await seedFullRestaurant(p, 'Prod', 'pr');
      const health = await p.anon().get('/api/health');
      expect(health.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
      const login = await p.anon().post('/api/auth/login', { email: f.emails.manager, password: PASSWORD });
      expect(login.status).toBe(200);
      const cookie = login.headers.getSetCookie()[0]!;
      expect(cookie).toStartWith('__Host-altiora_sid=');
      for (const attr of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) expect(cookie).toContain(attr);
      expect(cookie.toLowerCase()).not.toContain('domain=');
      expect(cookie).toMatch(/Max-Age=\d+/);
    } finally {
      await p.close();
    }
  });

  test('em desenvolvimento/testes o cookie não exige HTTPS e tem outro nome', async () => {
    const login = await t.anon().post('/api/auth/login', { email: F.emails.waiter, password: PASSWORD });
    const cookie = login.headers.getSetCookie()[0]!;
    expect(cookie).toStartWith('altiora_sid=');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
  });
});

describe('pedidos forjados por outros sites (CSRF) e CORS', () => {
  const rename = (c: Client, name: string, headers: Record<string, string> = {}, noOrigin = false) => c.patch('/api/restaurants/current', { name }, { headers, noOrigin });
  const currentName = async () => (await manager.get('/api/restaurants/current')).body.restaurant.name as string;

  test('uma alteração vinda de outro site é recusada, mesmo com o cookie de sessão', async () => {
    const before = await currentName();
    const r = await rename(manager, 'Alterado por intruso', { origin: 'https://site-malicioso.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(await currentName()).toBe(before);
    // sem Origin mas com indicação do navegador de que veio de outro site
    for (const site of ['cross-site', 'same-site']) {
      const x = await rename(manager, 'Alterado por intruso', { 'sec-fetch-site': site }, true);
      expect({ site, status: x.status }).toEqual({ site, status: 403 });
    }
    expect(await currentName()).toBe(before);
  });

  test('o próprio site e clientes sem navegador (sem Origin) são aceites', async () => {
    expect((await rename(manager, 'Http A', { 'sec-fetch-site': 'same-origin' }, true)).status).toBe(200);
    expect((await rename(manager, 'Http B', {}, true)).status).toBe(200);
    expect((await rename(manager, 'Http C', { origin: ORIGIN })).status).toBe(200);
    // o mesmo servidor, escrito com outro porto, já é outro site
    expect((await rename(manager, 'Http D', { origin: 'http://app.test:8080' })).status).toBe(403);
    expect(await currentName()).toBe('Http C');
  });

  test('CORS: só as origens configuradas recebem permissão (nunca "*"), com cookies', async () => {
    const c = await startTestApp({ env: { WEB_DIR: webDir, ALLOWED_ORIGINS: 'https://painel.altiora.test, https://outro.altiora.test/' } });
    try {
      const f = await seedFullRestaurant(c, 'Cors', 'co');
      const m = await c.login(f.emails.manager);

      // pedido normal vindo de uma origem autorizada
      const ok = await m.get('/api/restaurants/current', { headers: { origin: 'https://painel.altiora.test' } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://painel.altiora.test');
      expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
      expect(ok.headers.get('vary')).toContain('Origin');
      // a barra final da configuração é ignorada
      expect((await m.get('/api/health', { headers: { origin: 'https://outro.altiora.test' } })).headers.get('access-control-allow-origin')).toBe('https://outro.altiora.test');

      // origem desconhecida: nenhuma permissão
      const no = await m.get('/api/health', { headers: { origin: 'https://site-malicioso.example' } });
      expect(no.headers.get('access-control-allow-origin')).toBeNull();
      expect(no.headers.get('access-control-allow-credentials')).toBeNull();
      // nem por parecer semelhante
      for (const o of ['https://painel.altiora.test.evil.example', 'http://painel.altiora.test', 'https://painel.altiora.test:444', 'null']) {
        expect({ o, acao: (await anonGet(c, o)).headers.get('access-control-allow-origin') }).toEqual({ o, acao: null });
      }

      // pré-verificação (preflight)
      const pre = await c.anon().request('OPTIONS', '/api/orders/x', { headers: { origin: 'https://painel.altiora.test', 'access-control-request-method': 'POST' } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe('https://painel.altiora.test');
      expect(pre.headers.get('access-control-allow-methods')).toContain('PATCH');
      expect(pre.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
      const preBad = await c.anon().request('OPTIONS', '/api/orders/x', { headers: { origin: 'https://site-malicioso.example', 'access-control-request-method': 'POST' } });
      expect(preBad.status).toBe(204);
      expect(preBad.headers.get('access-control-allow-origin')).toBeNull();
      expect(preBad.headers.get('access-control-allow-methods')).toBeNull();

      // uma alteração vinda da origem autorizada passa a verificação de origem
      const patch = await m.patch('/api/restaurants/current', { name: 'Cors Novo' }, { headers: { origin: 'https://painel.altiora.test' } });
      expect(patch.status).toBe(200);
    } finally {
      await c.close();
    }
  });
});

async function anonGet(app: TestApp, origin: string) {
  return app.anon().get('/api/health', { headers: { origin } });
}

describe('corpo dos pedidos', () => {
  const rawPost = (body: BodyInit | null, headers: Record<string, string> = { 'content-type': 'application/json' }, init: Record<string, unknown> = {}) =>
    t.app.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, ...headers }, body, ...init } as RequestInit), { ip: '203.0.113.52' });
  const codeOf = async (res: Response) => ((await res.json()) as any).error.code as string;

  test('só se aceita JSON', async () => {
    const r = await rawPost('email=a&password=b', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(r.status).toBe(415);
    expect(await codeOf(r)).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((await rawPost('{}', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await rawPost('{}', {})).status).toBe(415);
    // com charset é aceite (e a validação seguinte recusa o conteúdo vazio)
    const ok = await rawPost('{}', { 'content-type': 'application/json; charset=utf-8' });
    expect(ok.status).toBe(400);
    expect(await codeOf(ok)).toBe('VALIDATION_ERROR');
  });

  test('corpo vazio, JSON inválido ou texto que não é UTF-8 são recusados com 400', async () => {
    const empty = await rawPost('');
    expect(empty.status).toBe(400);
    expect(await codeOf(empty)).toBe('INVALID_JSON');
    expect(await codeOf(await rawPost('{"email": '))).toBe('INVALID_JSON');
    expect(await codeOf(await rawPost("{'email': 'a'}"))).toBe('INVALID_JSON');
    const bytes = await rawPost(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    expect(bytes.status).toBe(400);
    expect(await codeOf(bytes)).toBe('INVALID_JSON');
  });

  test('corpos que não são objetos, ou com campos a mais, não passam; "__proto__" não polui nada', async () => {
    for (const body of ['null', '[]', '"texto"', '42', 'true']) {
      const r = await rawPost(body);
      expect({ body, status: r.status, code: await codeOf(r) }).toEqual({ body, status: 400, code: 'VALIDATION_ERROR' });
    }
    const evil = await rawPost('{"__proto__": {"isAdmin": true}, "email": "a@b.pt", "password": "x"}');
    expect(evil.status).toBe(400);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    const extra = await rawPost(JSON.stringify({ email: 'a@b.pt', password: 'x', is_platform_admin: true }));
    expect(extra.status).toBe(400);
  });

  test('mais de 64 KB é recusado (413), quer venha declarado quer em partes sem tamanho', async () => {
    const big = JSON.stringify({ email: 'a@b.pt', password: 'x'.repeat(70 * 1024) });
    const declared = await rawPost(big);
    expect(declared.status).toBe(413);
    expect(await codeOf(declared)).toBe('PAYLOAD_TOO_LARGE');

    const chunk = new TextEncoder().encode('x'.repeat(10 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 12) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const streamed = await rawPost(stream, { 'content-type': 'application/json' }, { duplex: 'half' });
    expect(streamed.status).toBe(413);
    expect(sent).toBeLessThan(12); // parou de ler assim que passou do limite
  });

  test('o texto com caracteres especiais (acentos, emojis, aspas) chega intacto ao pedido e é devolvido tal e qual', async () => {
    const c = t.anon('203.0.113.53');
    const notes = 'Sem cebola, por favor — "bem passado" 🍗 <b>negrito</b> & mais; ção à ç';
    const r = await c.post(`/api/public/menu/${F.table1.token}/orders`, orderBody(F.menu, { notes }), { headers: { 'idempotency-key': uniqueKey() } });
    expect(r.status).toBe(201);
    const again = await c.get(`/api/public/orders/${r.body.order.public_code}`);
    expect(again.body.order.notes).toBe(notes);
  });
});

describe('site (ficheiros estáticos)', () => {
  const get = (path: string, headers: Record<string, string> = {}) => t.app.fetch(new Request(ORIGIN + path, { headers }), { ip: '203.0.113.54' });

  test('a página inicial e os endereços da aplicação (ex.: /menu/..., /cozinha) devolvem o index.html sem cache', async () => {
    for (const path of ['/index.html', '/cozinha', '/cozinha/', '/menu/Zm9vYmFyMTIzNDU2Nzg5MA', '/gerente/mesas/3']) {
      const r = await get(path);
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(await r.text()).toBe(INDEX_HTML);
    }
  });

  test('ficheiros em /assets/ ficam em cache durante um ano; falta de ficheiro com extensão é 404 (não a página inicial)', async () => {
    const js = await get('/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(js.headers.get('vary')).toBe('Accept-Encoding');
    expect(js.headers.get('content-encoding')).toBeNull();
    expect(await js.text()).toBe(APP_JS);
    expect((await get('/assets/logo.svg')).headers.get('content-type')).toBe('image/svg+xml');
    for (const path of ['/assets/nao-existe.js', '/favicon.ico', '/assets/app.js.map']) {
      const r = await get(path);
      expect({ path, status: r.status }).toEqual({ path, status: 404 });
    }
  });

  test('usa as versões comprimidas já preparadas quando o navegador as aceita', async () => {
    const br = await get('/assets/app.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers.get('content-encoding')).toBe('br');
    const brBytes = new Uint8Array(await br.arrayBuffer());
    expect(Number(br.headers.get('content-length'))).toBe(brBytes.byteLength);
    expect(brotliDecompressSync(brBytes).toString()).toBe(APP_JS);
    expect(brBytes.byteLength).toBeLessThan(APP_JS.length);

    const gz = await get('/assets/app.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString()).toBe(APP_JS);

    const identity = await get('/assets/app.js', { 'accept-encoding': 'identity' });
    expect(identity.headers.get('content-encoding')).toBeNull();
    expect(await identity.text()).toBe(APP_JS);
    // "broken" não é "br"
    expect((await get('/assets/app.js', { 'accept-encoding': 'broken' })).headers.get('content-encoding')).toBeNull();
  });

  test('não é possível sair da pasta do site (nem com ..%2f, caracteres nulos ou contra-barras)', async () => {
    const attempts = [
      '/../segredo.txt',
      '/%2e%2e/segredo.txt',
      '/..%2fsegredo.txt',
      '/assets/..%2f..%2fsegredo.txt',
      '/assets/../../segredo.txt',
      '/..%2fweb-private%2fdados.txt',
      '/%2e%2e%2fweb-private%2fdados.txt',
      '/..%5csegredo.txt',
      '/assets/%00.js',
      '/segredo.txt%00.html',
      '/%252e%252e/segredo.txt',
      '//segredo.txt',
      '/web-private/dados.txt',
    ];
    for (const path of attempts) {
      const r = await get(path);
      const text = await r.text();
      expect({ path, vazou: text.includes('CONTEUDO-PRIVADO') }).toEqual({ path, vazou: false });
      expect([200, 400, 404]).toContain(r.status);
      if (r.status === 200) expect(text).toBe(INDEX_HTML); // só a página inicial, nunca outro ficheiro
    }
  });

  test('HEAD não devolve corpo; outros métodos não são aceites', async () => {
    const head = await t.app.fetch(new Request(ORIGIN + '/cozinha', { method: 'HEAD' }), { ip: '203.0.113.54' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(Number(head.headers.get('content-length'))).toBe(INDEX_HTML.length);
    const post = await t.app.fetch(new Request(ORIGIN + '/', { method: 'POST', body: 'x' }), { ip: '203.0.113.54' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  test('robots.txt e sitemap.xml: a API e os menus das mesas não são indexados; a página comercial sim', async () => {
    const robots = await get('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const txt = await robots.text();
    expect(txt).toContain('Disallow: /api/');
    expect(txt).toContain('Disallow: /menu/');
    expect(txt).toContain('Disallow: /pedido/');
    expect(txt).toContain('Sitemap: ');
    const sitemap = await get('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = await sitemap.text();
    expect(xml).toContain('<loc>');
    expect(xml).not.toContain('/menu/');
  });

  test('sem a aplicação construída, o aviso é claro (503) em vez de um erro técnico', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'altiora-vazio-'));
    const e = await startTestApp({ env: { WEB_DIR: empty } });
    try {
      const r = await e.anon().get('/menu/abc');
      expect(r.status).toBe(503);
      expect(String(r.body)).toContain('bun run build');
      expect((await e.anon().get('/api/health')).status).toBe(200); // a API funciona na mesma
    } finally {
      await e.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('verificação de saúde e base de dados indisponível', () => {
  test('/api/health indica o estado; se a base de dados falhar responde 503 e os pedidos recebem uma mensagem calma', async () => {
    const d = await startTestApp({ env: { WEB_DIR: webDir } });
    try {
      const f = await seedFullRestaurant(d, 'Sem BD', 'sb');
      await d.db.close();
      const c = d.anon();
      const health = await c.get('/api/health');
      expect(health.status).toBe(503);
      expect(health.body).toMatchObject({ status: 'degraded', database: 'indisponível' });
      expect(JSON.stringify(health.body)).not.toMatch(/postgres|ECONN|password/i);

      const menu = await c.get(`/api/public/menu/${f.table1.token}`);
      expect(menu.status).toBe(503);
      expect(menu.body.error.code).toBe('DB_UNAVAILABLE');
      expect(menu.headers.get('retry-after')).toBe('5');
      expect(menu.body.error.message).toContain('temporariamente indisponível');

      const login = await c.post('/api/auth/login', { email: f.emails.manager, password: PASSWORD });
      expect(login.status).toBe(503);
      // o site (ficheiros) continua a ser servido
      expect((await c.get('/')).status).toBe(200);
    } finally {
      await d.close().catch(() => undefined);
    }
  });

  test('o resultado da verificação é guardado 2 segundos: muitos pedidos seguidos não sobrecarregam a base de dados', async () => {
    let pings = 0;
    const original = t.db.ping.bind(t.db);
    t.db.ping = async () => {
      pings++;
      return original();
    };
    try {
      // a cache é por base de dados; aguardar que a validade da anterior termine
      await new Promise((r) => setTimeout(r, 2100));
      for (let i = 0; i < 25; i++) expect((await t.anon('203.0.113.55').get('/api/health')).status).toBe(200);
      expect(pings).toBe(1);
    } finally {
      t.db.ping = original;
    }
  });
});

describe('limites de pedidos por IP', () => {
  test('depois de muitos pedidos seguidos recebe 429 com o tempo de espera; outro IP não é afetado', async () => {
    const l = await startTestApp({ env: { WEB_DIR: webDir, RATE_LIMIT_ENABLED: 'true' } });
    try {
      const spammer = l.anon('198.51.100.7');
      const statuses: number[] = [];
      for (let i = 0; i < 130; i++) statuses.push((await spammer.get('/api/health')).status);
      expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(120).every((s) => s === 429)).toBe(true);
      const blocked = await spammer.get('/api/health');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      // outro cliente continua a ser atendido
      expect((await l.anon('198.51.100.8').get('/api/health')).status).toBe(200);
      // o IP indicado em X-Forwarded-For só vale se for o acrescentado pelo proxy de confiança (a última entrada)
      const forged = l.anon('198.51.100.7');
      const viaHeader = await forged.get('/api/health', { headers: { 'x-forwarded-for': '203.0.113.200, 198.51.100.7' } });
      expect(viaHeader.status).toBe(429);
      const fresh = l.anon('198.51.100.9');
      const spoof = await fresh.get('/api/health', { headers: { 'x-forwarded-for': '198.51.100.7, 198.51.100.9' } });
      expect(spoof.status).toBe(200);
    } finally {
      await l.close();
    }
  });
});

describe('registos (logs)', () => {
  test('nunca contêm palavras-passe, cookies de sessão, códigos de pedido, tokens dos QR Codes nem chaves de idempotência', async () => {
    const start = logLines.length;
    const c = t.anon('203.0.113.60');
    const staff = new Client(t.app, '203.0.113.61');
    const login = await staff.post('/api/auth/login', { email: F.emails.kitchen, password: PASSWORD });
    expect(login.status).toBe(200);
    const sid = staff.cookies.get('altiora_sid')!;
    expect(sid.length).toBeGreaterThan(30);
    const key = uniqueKey();
    const menu = await c.get(`/api/public/menu/${F.table2.token}`);
    expect(menu.status).toBe(200);
    const order = await c.post(`/api/public/menu/${F.table2.token}/orders`, orderBody(F.menu), { headers: { 'idempotency-key': key } });
    expect(order.status).toBe(201);
    const code = order.body.order.public_code as string;
    expect((await c.get(`/api/public/orders/${code}`)).status).toBe(200);
    expect((await c.get(`/api/public/orders/${code}x`)).status).toBe(404);
    expect((await c.get(`/api/public/menu/${F.table2.token}x`)).status).toBe(404);
    expect((await staff.get('/api/orders')).status).toBe(200);
    expect((await t.anon('203.0.113.62').post('/api/auth/login', { email: F.emails.kitchen, password: 'Palavra-Errada-999' })).status).toBe(401);

    const text = logLines.slice(start).join('\n');
    expect(text.length).toBeGreaterThan(200); // houve mesmo registos
    for (const secret of [PASSWORD, 'Palavra-Errada-999', sid, code, F.table2.token, key]) {
      expect({ secret: secret.slice(0, 6) + '…', presente: text.includes(secret) }).toEqual({ secret: secret.slice(0, 6) + '…', presente: false });
    }
    // os registos mostram o modelo da rota (não o endereço com o segredo)
    expect(text).toContain('GET /api/public/menu/:token');
    expect(text).toContain('GET /api/public/orders/:code');
    expect(text).not.toContain('/api/public/menu/' + F.table2.token);
  });
});
