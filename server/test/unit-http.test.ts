// Peças pequenas do servidor testadas isoladamente (sem base de dados): limites de pedidos, rotas, IP do cliente,
// cookies, verificação de origem, avisos em tempo real (SSE), tradução de erros e leitura da configuração.
import { describe, expect, test } from 'bun:test';
import { ZodError, z } from 'zod';
import { ConfigError, databaseTransportWarning, loadConfig } from '../src/config';
import { describeDbFailure } from '../src/db/client';
import { Hub, type HubEvent } from '../src/http/hub';
import { clientIp } from '../src/http/client-ip';
import { parseCookies, serializeCookie } from '../src/http/cookies';
import { mapError } from '../src/http/errors-map';
import { LoginThrottle, RateLimiter } from '../src/http/rate-limit';
import { Router } from '../src/http/router';
import { assertSameOrigin, buildOriginPolicy, corsHeaders, isAllowedOrigin, preflightResponse } from '../src/http/security';
import { sseResponse } from '../src/http/sse';
import type { RouteSpec } from '../src/http/types';
import { HttpError, tooMany } from '../src/lib/errors';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dummy = (method: RouteSpec['method'], path: string): RouteSpec => ({ method, path, access: 'public', handler: () => new Response('ok') });

describe('RateLimiter', () => {
  const make = (max = 100_000) => {
    const clock = { t: 1_000_000 };
    return { clock, rl: new RateLimiter(true, max, () => clock.t) };
  };

  test('deixa passar `max` pedidos por janela e depois bloqueia com o tempo de espera', () => {
    const { rl } = make();
    for (let i = 0; i < 3; i++) expect(rl.hit('k', 3, 60_000).ok).toBe(true);
    const blocked = rl.hit('k', 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(20); // 3 pedidos por minuto = 1 a cada 20 s
  });

  test('repõe as fichas de forma contínua, sem nunca acumular mais do que o máximo', () => {
    const { rl, clock } = make();
    for (let i = 0; i < 3; i++) rl.hit('k', 3, 60_000);
    clock.t += 19_000;
    expect(rl.hit('k', 3, 60_000).ok).toBe(false);
    clock.t += 1_500; // 20,5 s no total → 1 ficha
    expect(rl.hit('k', 3, 60_000).ok).toBe(true);
    expect(rl.hit('k', 3, 60_000).ok).toBe(false);
    clock.t += 60 * 60_000; // uma hora depois: só 3 outra vez
    const results = Array.from({ length: 5 }, () => rl.hit('k', 3, 60_000).ok);
    expect(results).toEqual([true, true, true, false, false]);
  });

  test('chaves diferentes não se afetam; desligado deixa tudo passar', () => {
    const { rl } = make();
    for (let i = 0; i < 5; i++) rl.hit('a', 2, 1000);
    expect(rl.hit('a', 2, 1000).ok).toBe(false);
    expect(rl.hit('b', 2, 1000).ok).toBe(true);
    const off = new RateLimiter(false);
    for (let i = 0; i < 1000; i++) expect(off.hit('x', 1, 1000).ok).toBe(true);
    expect(off.size).toBe(0);
  });

  test('limpa baldes antigos e nunca cresce sem limite', () => {
    const { rl, clock } = make();
    rl.hit('a', 5, 1000);
    rl.hit('b', 5, 1000);
    expect(rl.size).toBe(2);
    clock.t += 11 * 60_000;
    rl.prune();
    expect(rl.size).toBe(0);

    const small = make(10);
    for (let i = 0; i < 100; i++) small.rl.hit(`k${i}`, 5, 1000);
    expect(small.rl.size).toBeLessThanOrEqual(10);
  });

  test('a mensagem de espera para o cliente tem pelo menos 1 segundo', () => {
    const e = tooMany('x', 0.2);
    expect(e.status).toBe(429);
    expect(e.headers?.['retry-after']).toBe('1');
    expect(tooMany('x', 12.3).headers?.['retry-after']).toBe('13');
  });
});

describe('LoginThrottle', () => {
  const make = (enabled = true) => {
    const clock = { t: 5_000_000 };
    return { clock, th: new LoginThrottle(enabled, () => clock.t, 15 * 60_000) };
  };

  test('bloqueia depois de demasiadas falhas e liberta passado o tempo', () => {
    const { th, clock } = make();
    for (let i = 0; i < 4; i++) th.fail('k');
    expect(th.check('k', 5)).toBe(0);
    th.fail('k');
    const wait = th.check('k', 5);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(900);
    clock.t += 10 * 60_000;
    expect(th.check('k', 5)).toBeGreaterThan(0);
    expect(th.check('k', 5)).toBeLessThanOrEqual(300);
    clock.t += 5 * 60_000 + 1000;
    expect(th.check('k', 5)).toBe(0);
    th.fail('k'); // recomeça do zero
    expect(th.check('k', 2)).toBe(0);
  });

  test('um início de sessão bem sucedido apaga as falhas; chaves independentes; desligado não bloqueia', () => {
    const { th } = make();
    for (let i = 0; i < 5; i++) th.fail('a');
    expect(th.check('a', 5)).toBeGreaterThan(0);
    expect(th.check('b', 5)).toBe(0);
    th.success('a');
    expect(th.check('a', 5)).toBe(0);
    const off = make(false).th;
    for (let i = 0; i < 50; i++) off.fail('a');
    expect(off.check('a', 1)).toBe(0);
  });
});

describe('Router', () => {
  const router = new Router();
  router.addAll([dummy('GET', '/api/a/:id'), dummy('POST', '/api/a/:id'), dummy('GET', '/api/a.b'), dummy('GET', '/api/x/:a/y/:b'), dummy('POST', '/api/only-post')]);

  test('encontra rotas, extrai e descodifica os parâmetros', () => {
    const m = router.match('GET', '/api/a/123');
    expect(m.kind).toBe('ok');
    if (m.kind === 'ok') expect(m.params).toEqual({ id: '123' });
    const two = router.match('GET', '/api/x/um/y/dois%20tres');
    if (two.kind === 'ok') expect(two.params).toEqual({ a: 'um', b: 'dois tres' });
    else throw new Error('devia encontrar');
    const accent = router.match('GET', '/api/a/%C3%A7');
    if (accent.kind === 'ok') expect(accent.params.id).toBe('ç');
    // percentagem mal formada não rebenta: fica como veio
    const bad = router.match('GET', '/api/a/%E0%A4%A');
    expect(bad.kind).toBe('ok');
    // barra final aceite
    expect(router.match('GET', '/api/a/123/').kind).toBe('ok');
  });

  test('o ponto é só um ponto; parâmetros não atravessam "/"; HEAD usa as rotas GET', () => {
    expect(router.match('GET', '/api/a.b').kind).toBe('ok');
    expect(router.match('GET', '/api/aXb').kind).toBe('none');
    expect(router.match('GET', '/api/a/1/2').kind).toBe('none');
    expect(router.match('GET', '/api/a/').kind).toBe('none');
    expect(router.match('GET', '/api').kind).toBe('none');
    expect(router.match('HEAD', '/api/a/1').kind).toBe('ok');
    expect(router.match('HEAD', '/api/only-post').kind).toBe('method');
  });

  test('método errado devolve a lista de métodos permitidos', () => {
    const m = router.match('DELETE', '/api/a/1');
    expect(m.kind).toBe('method');
    if (m.kind === 'method') expect(m.allow.sort()).toEqual(['GET', 'POST']);
    expect(router.list()).toHaveLength(5);
  });
});

describe('clientIp (IP do cliente)', () => {
  const req = (xff?: string) => new Request('http://x/', { headers: xff ? { 'x-forwarded-for': xff } : {} });

  test('sem proxy de confiança ignora X-Forwarded-For', () => {
    expect(clientIp(req('1.2.3.4'), '9.9.9.9', 0)).toBe('9.9.9.9');
    expect(clientIp(req(), undefined, 0)).toBe('unknown');
  });

  test('com 1 proxy usa a última entrada (a acrescentada pelo proxy), não a que o cliente pode inventar', () => {
    expect(clientIp(req('6.6.6.6, 203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientIp(req('203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientIp(req(), '10.0.0.1', 1)).toBe('10.0.0.1');
  });

  test('com 2 proxies usa a penúltima; com menos entradas do que saltos usa a primeira', () => {
    expect(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), '10.0.0.1', 2)).toBe('2.2.2.2');
    expect(clientIp(req('1.1.1.1'), '10.0.0.1', 3)).toBe('1.1.1.1');
  });

  test('valores que não parecem um IP são ignorados (nunca vão parar às chaves nem aos registos)', () => {
    for (const bad of ['<script>', 'a b', "1.2.3.4'; --", 'x'.repeat(50), 'um,dois', ',', ' , ']) {
      expect({ bad, ip: clientIp(req(bad), '10.0.0.1', 1) }).toEqual({ bad, ip: '10.0.0.1' });
    }
    expect(clientIp(req('2001:db8::1'), '10.0.0.1', 1)).toBe('2001:db8::1');
    expect(clientIp(req('::1'), undefined, 1)).toBe('::1');
    expect(clientIp(req(), 'não-é-ip', 1)).toBe('unknown');
  });
});

describe('cookies', () => {
  test('lê vários cookies, aceita "=" no valor, ignora lixo e fica com o primeiro de nomes repetidos', () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('a=1; b=2;c=3')).toEqual({ a: '1', b: '2', c: '3' });
    expect(parseCookies('a=x=y==')).toEqual({ a: 'x=y==' });
    expect(parseCookies('=sem-nome; ; lixo; ok=1')).toEqual({ ok: '1' });
    expect(parseCookies('a=1; a=2')).toEqual({ a: '1' });
  });

  test('nomes especiais não alteram o objeto (sem poluição de protótipos)', () => {
    const r = parseCookies('__proto__=x; constructor=y; toString=z; ok=1');
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(Object.keys(r)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('o cookie de sessão sai com HttpOnly e SameSite; Secure só quando pedido; Max-Age nunca negativo', () => {
    expect(serializeCookie('altiora_sid', 'abc', { secure: false })).toBe('altiora_sid=abc; Path=/; HttpOnly; SameSite=Lax');
    expect(serializeCookie('__Host-altiora_sid', 'abc', { secure: true, maxAgeSec: 3600.9 })).toBe('__Host-altiora_sid=abc; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax');
    expect(serializeCookie('a', '', { secure: false, maxAgeSec: 0 })).toContain('Max-Age=0');
    expect(serializeCookie('a', '', { secure: false, maxAgeSec: -50 })).toContain('Max-Age=0');
    expect(serializeCookie('a', 'v', { secure: false, sameSite: 'Strict', httpOnly: false })).toBe('a=v; Path=/; SameSite=Strict');
  });
});

describe('verificação de origem (CSRF) e CORS', () => {
  const policy = buildOriginPolicy('https://menu.altiora.ao', ['https://painel.altiora.ao']);
  const url = new URL('https://menu.altiora.ao/api/orders/1');
  const request = (headers: Record<string, string>) => new Request(url, { method: 'PATCH', headers });

  test('origens permitidas: as configuradas e o próprio servidor', () => {
    expect(isAllowedOrigin('https://menu.altiora.ao', url, policy)).toBe(true);
    expect(isAllowedOrigin('https://painel.altiora.ao', url, policy)).toBe(true);
    expect(isAllowedOrigin('https://outro.example', url, policy)).toBe(false);
    expect(isAllowedOrigin('https://menu.altiora.ao.evil.example', url, policy)).toBe(false);
    expect(isAllowedOrigin('null', url, policy)).toBe(false);
    expect(isAllowedOrigin('', url, policy)).toBe(false);
    expect(isAllowedOrigin('lixo', url, policy)).toBe(false);
  });

  test('assertSameOrigin: Origin manda; sem Origin vale Sec-Fetch-Site; sem nenhum (ex.: curl) passa', () => {
    expect(() => assertSameOrigin(request({ origin: 'https://menu.altiora.ao' }), url, policy)).not.toThrow();
    expect(() => assertSameOrigin(request({ origin: 'https://painel.altiora.ao' }), url, policy)).not.toThrow();
    expect(() => assertSameOrigin(request({ origin: 'https://evil.example' }), url, policy)).toThrow(HttpError);
    expect(() => assertSameOrigin(request({ origin: 'null' }), url, policy)).toThrow(HttpError);
    // Origin válido prevalece mesmo que o Sec-Fetch-Site diga outra coisa; Origin inválido nunca é salvo por Sec-Fetch-Site
    expect(() => assertSameOrigin(request({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }), url, policy)).toThrow(HttpError);
    expect(() => assertSameOrigin(request({ 'sec-fetch-site': 'same-origin' }), url, policy)).not.toThrow();
    expect(() => assertSameOrigin(request({ 'sec-fetch-site': 'none' }), url, policy)).not.toThrow();
    expect(() => assertSameOrigin(request({ 'sec-fetch-site': 'cross-site' }), url, policy)).toThrow(HttpError);
    expect(() => assertSameOrigin(request({ 'sec-fetch-site': 'same-site' }), url, policy)).toThrow(HttpError);
    expect(() => assertSameOrigin(request({}), url, policy)).not.toThrow();
    try {
      assertSameOrigin(request({ origin: 'https://evil.example' }), url, policy);
    } catch (e) {
      expect((e as HttpError).status).toBe(403);
      expect((e as HttpError).code).toBe('ORIGIN_NOT_ALLOWED');
    }
  });

  test('CORS só para origens configuradas e diferentes do próprio site; a resposta ao preflight lista métodos e cabeçalhos', () => {
    expect(corsHeaders(request({ origin: 'https://painel.altiora.ao' }), url, policy)).toEqual({
      'access-control-allow-origin': 'https://painel.altiora.ao',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    });
    expect(corsHeaders(request({ origin: 'https://menu.altiora.ao' }), url, policy)).toBeNull(); // mesmo site: não precisa
    expect(corsHeaders(request({ origin: 'https://evil.example' }), url, policy)).toBeNull();
    expect(corsHeaders(request({}), url, policy)).toBeNull();
    const pre = preflightResponse(request({ origin: 'https://painel.altiora.ao' }), url, policy);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, PATCH, PUT, DELETE, OPTIONS');
    expect(pre.headers.get('access-control-allow-headers')).toBe('Content-Type, Idempotency-Key');
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://painel.altiora.ao');
    const denied = preflightResponse(request({ origin: 'https://evil.example' }), url, policy);
    expect(denied.status).toBe(204);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Hub (avisos em tempo real)', () => {
  test('entrega eventos só a quem subscreveu aquele restaurante / pedido; cancelar a subscrição funciona', () => {
    const hub = new Hub();
    const got: string[] = [];
    const offA = hub.subscribeRestaurant('A', (e) => got.push('A:' + e.type));
    hub.subscribeRestaurant('B', (e) => got.push('B:' + e.type));
    hub.subscribeOrder('code1', (e) => got.push('o1:' + e.type));
    expect(hub.connectionCount).toBe(3);
    hub.publishRestaurant('A', { type: 'order.new' });
    hub.publishOrder('code1', { type: 'order.status' });
    hub.publishOrder('outro', { type: 'order.status' });
    hub.publishRestaurant('C', { type: 'nada' });
    expect(got).toEqual(['A:order.new', 'o1:order.status']);
    offA();
    offA(); // repetir não conta duas vezes
    expect(hub.connectionCount).toBe(2);
    hub.publishRestaurant('A', { type: 'order.new' });
    expect(got).toHaveLength(2);
  });

  test('um ouvinte que falha não impede os outros', () => {
    const hub = new Hub();
    const got: number[] = [];
    hub.subscribeRestaurant('A', () => {
      throw new Error('falhou');
    });
    hub.subscribeRestaurant('A', () => got.push(1));
    expect(() => hub.publishRestaurant('A', { type: 'x' })).not.toThrow();
    expect(got).toEqual([1]);
  });

  test('vagas por chave: respeita o máximo e liberta uma só vez', () => {
    const hub = new Hub();
    const a = hub.acquireSlot('ip1', 2)!;
    const b = hub.acquireSlot('ip1', 2)!;
    expect(typeof a).toBe('function');
    expect(typeof b).toBe('function');
    expect(hub.acquireSlot('ip1', 2)).toBeNull();
    expect(hub.acquireSlot('ip2', 2)).not.toBeNull();
    a();
    a(); // libertar duas vezes não cria vagas extra
    const c = hub.acquireSlot('ip1', 2);
    expect(c).not.toBeNull();
    expect(hub.acquireSlot('ip1', 2)).toBeNull();
    b();
    c!();
    expect(hub.acquireSlot('ip1', 1)).not.toBeNull();
  });
});

describe('sseResponse (ligação em tempo real)', () => {
  const decode = new TextDecoder();

  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string, timeoutMs = 1000): Promise<string> {
    let buf = '';
    const deadline = Date.now() + timeoutMs;
    while (!buf.includes(text)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`não chegou "${text}"; recebido: ${JSON.stringify(buf)}`);
      const r = await Promise.race([reader.read(), sleep(left).then(() => 'timeout' as const)]);
      if (r === 'timeout') throw new Error(`não chegou "${text}"; recebido: ${JSON.stringify(buf)}`);
      if (r.done) break;
      buf += decode.decode(r.value);
    }
    return buf;
  }

  test('envia a recomendação de reconexão, o evento inicial, os eventos seguintes e sinais de vida; ao desligar limpa tudo uma só vez', async () => {
    const abort = new AbortController();
    let send: (e: HubEvent) => void = () => {};
    let unsubscribed = 0;
    let closed = 0;
    const res = sseResponse(new Request('http://x/', { signal: abort.signal }), {
      hello: { type: 'hello' },
      heartbeatMs: 25,
      subscribe: (s) => {
        send = s;
        return () => unsubscribed++;
      },
      onClose: () => closed++,
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const first = await readUntil(reader, 'event: hello');
    expect(first).toContain('retry: 3000');
    expect(first).toContain('id: 1\nevent: hello\ndata: {"type":"hello"}\n\n');
    send({ type: 'order.new', id: 'x' });
    const second = await readUntil(reader, 'event: order.new');
    expect(second).toContain('id: 2\nevent: order.new\ndata: {"type":"order.new","id":"x"}\n\n');
    await readUntil(reader, ': ping');
    abort.abort();
    const rest = await readUntil(reader, '__nunca__').catch(() => 'terminou');
    expect(typeof rest).toBe('string');
    await sleep(20);
    expect(unsubscribed).toBe(1);
    expect(closed).toBe(1);
    send({ type: 'depois' }); // enviar depois de fechar não faz nada nem rebenta
  });

  test('fecha sozinha ao fim do tempo máximo (o navegador volta a ligar-se)', async () => {
    let closed = 0;
    let unsubscribed = 0;
    const res = sseResponse(new Request('http://x/'), { subscribe: () => () => unsubscribed++, maxLifetimeMs: 60, heartbeatMs: 1000, onClose: () => closed++ });
    const reader = res.body!.getReader();
    const started = Date.now();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(closed).toBe(1);
    expect(unsubscribed).toBe(1);
  });

  test('se o navegador cancelar a leitura, os recursos também são libertados', async () => {
    let closed = 0;
    let unsubscribed = 0;
    const res = sseResponse(new Request('http://x/'), { subscribe: () => () => unsubscribed++, heartbeatMs: 20, onClose: () => closed++ });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(closed).toBe(1);
    expect(unsubscribed).toBe(1);
  });
});

describe('mapError (erros → respostas seguras)', () => {
  const pg = (errno: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('mensagem técnica SECRETA'), { errno, ...extra });

  test('erros do próprio servidor passam tal e qual; falhas 5xx contam como falha do servidor', () => {
    const e = new HttpError(409, 'X', 'msg');
    expect(mapError(e)).toEqual({ error: e, serverFault: false });
    const e5 = new HttpError(503, 'Y', 'msg');
    expect(mapError(e5).serverFault).toBe(true);
  });

  test('erros de validação viram 400 com a lista de campos', () => {
    let zerr: ZodError | null = null;
    try {
      z.object({ a: z.string() }).parse({});
    } catch (e) {
      zerr = e as ZodError;
    }
    const m = mapError(zerr);
    expect(m.error.status).toBe(400);
    expect(m.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(m.error.details)).toBe(true);
    expect(m.serverFault).toBe(false);
  });

  test('códigos da base de dados (SQLSTATE) → estado, código e mensagem em português', () => {
    const table: Array<[string, number, string, boolean]> = [
      ['AL001', 409, 'INVALID_TRANSITION', false],
      ['AL002', 422, 'REASON_REQUIRED', false],
      ['AL003', 409, 'ORDER_IMMUTABLE', false],
      ['AL004', 404, 'RESTAURANT_NOT_FOUND', false],
      ['AL005', 422, 'INVALID_TIMEZONE', false],
      ['AL006', 404, 'TABLE_NOT_FOUND', false],
      ['23505', 409, 'DUPLICATE', false],
      ['23503', 409, 'REFERENCE_CONFLICT', false],
      ['23514', 422, 'INVALID_DATA', false],
      ['23502', 422, 'INVALID_DATA', false],
      ['22001', 422, 'INVALID_DATA', false],
      ['22003', 422, 'INVALID_DATA', false],
      ['22P02', 400, 'BAD_REQUEST', false],
      ['22007', 400, 'BAD_REQUEST', false],
      ['22021', 400, 'BAD_REQUEST', false],
      ['42501', 403, 'FORBIDDEN', true],
      ['57014', 503, 'DB_TIMEOUT', true],
      ['40001', 503, 'DB_CONFLICT', false],
      ['40P01', 503, 'DB_CONFLICT', false],
    ];
    for (const [sqlstate, status, code, serverFault] of table) {
      const m = mapError(pg(sqlstate));
      expect({ sqlstate, status: m.error.status, code: m.error.code, serverFault: m.serverFault }).toEqual({ sqlstate, status, code, serverFault });
      expect(JSON.stringify(m.error)).not.toContain('SECRETA');
      expect(/[ãáéíóúç]|\./.test(m.error.message)).toBe(true); // mensagens em português, com pontuação
    }
  });

  test('violação de unicidade usa a mensagem da restrição conhecida, ou uma genérica', () => {
    expect(mapError(pg('23505', { constraint: 'restaurant_tables_number_uq' })).error.message).toBe('Já existe uma mesa com este número.');
    expect(mapError(pg('23505', { constraint: 'categories_name_uq' })).error.message).toBe('Já existe uma categoria com este nome.');
    expect(mapError(pg('23505', { constraint: 'qualquer_outra' })).error.message).toBe('Já existe um registo com estes dados.');
    expect(mapError(pg('23505')).error.message).toBe('Já existe um registo com estes dados.');
  });

  test('tempo esgotado e conflitos pedem para tentar de novo (Retry-After)', () => {
    expect(mapError(pg('57014')).error.headers?.['retry-after']).toBe('3');
    expect(mapError(pg('40P01')).error.headers?.['retry-after']).toBe('1');
  });

  test('sem ligação à base de dados → 503 DB_UNAVAILABLE; erros desconhecidos → 500 genérico sem a mensagem original', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ERR_POSTGRES_CONNECTION_CLOSED', 'ERR_POSTGRES_CONNECTION_TIMEOUT']) {
      const m = mapError(Object.assign(new Error('postgres://u:SECRETA@h/db'), { code }));
      expect({ code, status: m.error.status, c: m.error.code, fault: m.serverFault }).toEqual({ code, status: 503, c: 'DB_UNAVAILABLE', fault: true });
      expect(m.error.headers?.['retry-after']).toBe('5');
      expect(JSON.stringify(m.error)).not.toContain('SECRETA');
    }
    for (const weird of [new Error('SECRETA'), 'SECRETA', null, undefined, 42, { code: 5 }, pg('XX999')]) {
      const m = mapError(weird);
      expect(m.error.status).toBe(500);
      expect(m.error.code).toBe('INTERNAL_ERROR');
      expect(m.serverFault).toBe(true);
      expect(JSON.stringify(m.error)).not.toContain('SECRETA');
    }
    // SQLSTATE com formato inválido não é tratado como código da base de dados
    expect(mapError(pg('abc')).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('configuração (variáveis de ambiente)', () => {
  const base = { DATABASE_URL: 'postgres://u:p@h:5432/db' };
  const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });
  const problems = (env: Record<string, string>): string[] => {
    try {
      loadConfig(env);
    } catch (e) {
      if (e instanceof ConfigError) return e.problems;
      throw e;
    }
    return [];
  };

  test('valores por omissão sensatos', () => {
    const c = cfg();
    expect(c).toMatchObject({
      env: 'development', isProd: false, port: 3000, trustProxyHops: 1, autoMigrate: true, cookieSecure: false, sessionIdleHours: 12, sessionMaxDays: 14,
      tableSessionMinutes: 240, rateLimitEnabled: true, databaseSsl: 'auto', publicBaseUrl: 'http://localhost:3000', bootstrapAdmin: null, allowedOrigins: [],
    });
    expect(c.limits).toEqual({ maxPendingOrdersPerTable: 8, minSecondsBetweenOrders: 3, maxOrderLines: 40, maxOrderQuantity: 100, maxOrderTotalCents: 1_000_000_000_000 });
  });

  test('DATABASE_URL é obrigatório e tem de ser PostgreSQL', () => {
    expect(problems({}).join(' ')).toContain('DATABASE_URL');
    expect(problems({ DATABASE_URL: 'mysql://x/y' }).join(' ')).toContain('postgres://');
    expect(problems({ DATABASE_URL: '   ' }).join(' ')).toContain('DATABASE_URL');
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/Configuração inválida/);
  });

  test('variáveis vazias contam como "não definidas"; números fora do intervalo são recusados com o nome da variável', () => {
    expect(cfg({ PORT: '' }).port).toBe(3000);
    expect(cfg({ PORT: '  8080 ' }).port).toBe(8080);
    for (const [k, v] of [['PORT', 'abc'], ['PORT', '70000'], ['PORT', '0'], ['MIN_SECONDS_BETWEEN_ORDERS', '61'], ['MAX_PENDING_ORDERS_PER_TABLE', '0'], ['SCRYPT_LOG_N', '9'], ['TABLE_SESSION_MINUTES', '5'], ['NODE_ENV', 'staging'], ['LOG_LEVEL', 'verbose']] as const) {
      expect({ k, mentions: problems({ ...base, [k]: v }).some((p) => p.includes(k)) }).toEqual({ k, mentions: true });
    }
  });

  test('várias falhas são reportadas de uma vez', () => {
    const p = problems({ PORT: 'x', NODE_ENV: 'staging', DATABASE_URL: 'ftp://x' });
    expect(p.length).toBe(3);
  });

  test('em produção: HTTPS obrigatório e cookie seguro por omissão (a menos que se diga o contrário)', () => {
    expect(problems({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://menu.exemplo.ao' }).join(' ')).toContain('https://');
    const prod = cfg({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://menu.exemplo.ao/' });
    expect(prod.isProd).toBe(true);
    expect(prod.cookieSecure).toBe(true);
    expect(prod.publicBaseUrl).toBe('https://menu.exemplo.ao'); // sem barra final nem caminho
    expect(cfg({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://menu.exemplo.ao', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(cfg({ COOKIE_SECURE: 'sim' }).cookieSecure).toBe(true);
  });

  test('no Render, o endereço público vem do próprio serviço, a menos que PUBLIC_BASE_URL esteja definido', () => {
    const render = { NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://altiora-pedidos.onrender.com' };
    expect(cfg(render).publicBaseUrl).toBe('https://altiora-pedidos.onrender.com');
    expect(cfg(render).cookieSecure).toBe(true);
    expect(cfg({ ...render, PUBLIC_BASE_URL: 'https://pedidos.restaurante.ao' }).publicBaseUrl).toBe('https://pedidos.restaurante.ao');
    expect(cfg({ ...render, PUBLIC_BASE_URL: '   ' }).publicBaseUrl).toBe('https://altiora-pedidos.onrender.com');
    // sem nenhum dos dois, em produção, o servidor recusa arrancar (https é obrigatório)
    expect(problems({ ...base, NODE_ENV: 'production' }).join(' ')).toContain('https://');
  });

  test('origens autorizadas: lista normalizada; endereços inválidos recusados', () => {
    expect(cfg({ ALLOWED_ORIGINS: 'https://a.pt/caminho, ,https://b.pt:8443/ ' }).allowedOrigins).toEqual(['https://a.pt', 'https://b.pt:8443']);
    expect(problems({ ...base, ALLOWED_ORIGINS: 'https://a.pt, isto-nao-e-um-url' }).join(' ')).toContain('isto-nao-e-um-url');
  });

  test('conta de administração inicial: só é criada com e-mail e palavra-passe em conjunto; com um só, é ignorada (e o servidor arranca na mesma)', () => {
    for (const only of [{ BOOTSTRAP_ADMIN_EMAIL: 'a@b.pt' }, { BOOTSTRAP_ADMIN_PASSWORD: 'uma-palavra-longa' }] as Array<Record<string, string>>) {
      const c = cfg(only);
      expect(c.bootstrapAdmin).toBeNull();
      expect(c.bootstrapIncomplete).toBe(true);
    }
    expect(cfg({}).bootstrapIncomplete).toBe(false);
    expect(problems({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.pt', BOOTSTRAP_ADMIN_PASSWORD: 'curta' }).join(' ')).toContain('BOOTSTRAP_ADMIN_PASSWORD');
    expect(problems({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'nao-e-email', BOOTSTRAP_ADMIN_PASSWORD: 'uma-palavra-longa' }).join(' ')).toContain('BOOTSTRAP_ADMIN_EMAIL');
    const c = cfg({ BOOTSTRAP_ADMIN_EMAIL: 'Admin@Altiora.AO', BOOTSTRAP_ADMIN_PASSWORD: 'uma-palavra-longa-1' });
    expect(c.bootstrapAdmin).toEqual({ email: 'admin@altiora.ao', password: 'uma-palavra-longa-1', name: 'Administrador Altiora' });
    expect(c.bootstrapIncomplete).toBe(false);
  });

  test('a mensagem de erro nunca repete o valor das variáveis (para não expor palavras-passe nos registos do alojamento)', () => {
    const p = problems({ DATABASE_URL: 'mysql://utilizador:PalavraSecreta@host/db', BOOTSTRAP_ADMIN_EMAIL: 'a@b.pt', BOOTSTRAP_ADMIN_PASSWORD: 'curta' });
    expect(p.join(' ')).not.toContain('PalavraSecreta');
    expect(p.join(' ')).not.toContain('curta');
  });
});

describe('aviso de ligação à base de dados sem cifra', () => {
  const remote = 'postgres://postgres.abcdef:segredo@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';

  test('base de dados remota sem DATABASE_SSL=require: avisa (e o aviso não repete a palavra-passe)', () => {
    for (const ssl of ['auto', 'disable'] as const) {
      const w = databaseTransportWarning(remote, ssl);
      expect(w).toContain('DATABASE_SSL=require');
      expect(w).toContain('aws-0-eu-central-1.pooler.supabase.com');
      expect(w).not.toContain('segredo');
    }
  });

  test('com DATABASE_SSL=require, ou com sslmode exigente no endereço (modo automático), não avisa', () => {
    expect(databaseTransportWarning(remote, 'require')).toBeNull();
    for (const mode of ['require', 'verify-ca', 'verify-full']) expect(databaseTransportWarning(`${remote}?sslmode=${mode}`, 'auto')).toBeNull();
    // mas "disable" é uma decisão explícita de não cifrar: avisa mesmo que o endereço peça cifra
    expect(databaseTransportWarning(`${remote}?sslmode=require`, 'disable')).not.toBeNull();
    expect(databaseTransportWarning(`${remote}?sslmode=prefer`, 'auto')).not.toBeNull();
  });

  test('máquina local e rede privada: não avisa', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'postgres', 'dpg-abc123-a', 'db.internal', '10.0.3.4', '172.20.0.2', '192.168.1.9']) {
      expect({ host, warning: databaseTransportWarning(`postgres://u:p@${host}:5432/db`, 'auto') }).toEqual({ host, warning: null });
    }
    // 172.32.x.x e 11.x.x.x já são endereços públicos
    expect(databaseTransportWarning('postgres://u:p@172.32.0.1/db', 'auto')).not.toBeNull();
    expect(databaseTransportWarning('postgres://u:p@11.0.0.1/db', 'auto')).not.toBeNull();
  });

  test('endereço ilegível: não rebenta', () => {
    expect(databaseTransportWarning('isto não é um endereço', 'auto')).toBeNull();
  });
});

describe('descrição de falhas da base de dados (para o registo)', () => {
  test('inclui o código e a mensagem, sem palavras-passe de endereços de ligação', () => {
    const text = describeDbFailure(Object.assign(new Error('connect failed for postgres://admin:SuperSegredo@db.exemplo.com:5432/x  (timeout)\n'), { code: 'ERR_POSTGRES_CONNECTION_TIMEOUT' }));
    expect(text).toContain('ERR_POSTGRES_CONNECTION_TIMEOUT');
    expect(text).toContain('postgres://admin:***@db.exemplo.com');
    expect(text).not.toContain('SuperSegredo');
    expect(text).not.toContain('\n');
  });

  test('aceita valores que não são erros e limita o tamanho', () => {
    expect(describeDbFailure('falhou')).toBe('falhou');
    expect(describeDbFailure(null)).toBe('null');
    expect(describeDbFailure(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(240);
  });
});
