// Pedidos: duplicados, concorrência, limites contra abuso, dados maliciosos, pedidos manuais, listagens e tempo real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, orderBody, seedFullRestaurant, seedTable, startTestApp, uniqueKey, type TestApp } from './helpers';

let t: TestApp;
let A: Awaited<ReturnType<typeof seedFullRestaurant>>;
let B: Awaited<ReturnType<typeof seedFullRestaurant>>;

beforeAll(async () => {
  t = await startTestApp({ env: { MAX_PENDING_ORDERS_PER_TABLE: '100' } });
  A = await seedFullRestaurant(t, 'Restaurante A', 'a');
  B = await seedFullRestaurant(t, 'Restaurante B', 'b');
});
afterAll(async () => {
  await t.close();
});

const place = (c: Client, token: string, body: unknown, key = uniqueKey()) =>
  c.post(`/api/public/menu/${token}/orders`, body, { headers: { 'idempotency-key': key } });
const simple = (r: typeof A, qty = 1, extra: Record<string, unknown> = {}) => ({ items: [{ menu_item_id: r.menu.sumo.id, quantity: qty }], ...extra });
/** Conta as respostas por "estado + código de erro" (ex.: { '201 ok': 1, '429 ORDERING_TOO_FAST': 9 }), o que torna as falhas fáceis de ler. */
const tally = (rs: Array<{ status: number; body: any }>, into: Record<string, number> = {}) => {
  for (const r of rs) {
    const k = `${r.status} ${r.body?.error?.code ?? 'ok'}`;
    into[k] = (into[k] ?? 0) + 1;
  }
  return into;
};
const countOrders = (rid: string) => t.db.system(async (tx) => (await tx<{ n: number }>`SELECT count(*)::int AS n FROM orders WHERE restaurant_id = ${rid}`)[0]!.n);

describe('duplicados e concorrência', () => {
  test('10 envios simultâneos com a mesma chave criam UM só pedido', async () => {
    const c = t.anon('203.0.113.1');
    const key = uniqueKey();
    const before = await countOrders(A.restaurantId);
    const results = await Promise.all(Array.from({ length: 10 }, () => place(c, A.table1.token, orderBody(A.menu), key)));
    // um cria o pedido (201) e os outros nove recebem esse mesmo pedido (200); nunca um erro
    expect(tally(results)).toEqual({ '201 ok': 1, '200 ok': 9 });
    const codes = new Set(results.map((r) => r.body.order.public_code));
    expect(codes.size).toBe(1);
    expect((await countOrders(A.restaurantId)) - before).toBe(1);
  });

  test('20 pedidos simultâneos (chaves diferentes) recebem números diferentes e sequenciais', async () => {
    const c = t.anon('203.0.113.2');
    const before = await t.db.system(async (tx) => (await tx<{ m: number | null }>`SELECT max(order_number)::int AS m FROM orders WHERE restaurant_id = ${B.restaurantId}`)[0]!.m ?? 0);
    const results = await Promise.all(Array.from({ length: 20 }, () => place(c, B.table1.token, simple(B))));
    expect(tally(results)).toEqual({ '201 ok': 20 });
    const numbers = results.map((r) => r.body.order.order_number as number).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => before + 1 + i));
  });

  test('muitas rondas de envios repetidos em simultâneo: um pedido por ronda e nunca um erro', async () => {
    // a falha que isto apanha é rara (cerca de 1 em cada 1000 envios), por isso repete-se muitas vezes
    const f = await seedFullRestaurant(t, 'Rondas', 'rondas');
    const c = t.anon('203.0.113.6');
    const rounds = 40;
    const total: Record<string, number> = {};
    for (let i = 0; i < rounds; i++) {
      const key = uniqueKey();
      tally(await Promise.all(Array.from({ length: 10 }, () => place(c, f.table1.token, simple(f), key))), total);
    }
    expect(total).toEqual({ '201 ok': rounds, '200 ok': rounds * 9 });
    expect(await countOrders(f.restaurantId)).toBe(rounds);
  });

  test('a mesma chave noutra mesa do mesmo restaurante não devolve pedidos alheios', async () => {
    const c = t.anon('203.0.113.3');
    const key = uniqueKey();
    expect((await place(c, A.table1.token, simple(A), key)).status).toBe(201);
    const other = await place(c, A.table2.token, simple(A), key);
    expect(other.status).toBe(409); // chave já usada (não revela o pedido da outra mesa)
    expect(JSON.stringify(other.body)).not.toContain('public_code');
  });
});

describe('limites contra abuso', () => {
  test('pedidos "novos" a mais na mesma mesa são recusados; ao serem atendidos volta a ser possível', async () => {
    const t2 = await startTestApp({ env: { MAX_PENDING_ORDERS_PER_TABLE: '3' } });
    try {
      const f = await seedFullRestaurant(t2, 'Limite', 'l');
      const c = t2.anon('203.0.113.4');
      for (let i = 0; i < 3; i++) expect((await place(c, f.table1.token, simple(f))).status).toBe(201);
      const blocked = await place(c, f.table1.token, simple(f));
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('TOO_MANY_PENDING_ORDERS');
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      // outra mesa não é afetada
      expect((await place(c, f.table2.token, simple(f))).status).toBe(201);
      // a cozinha aceita um pedido → liberta uma vaga
      const kitchen = await t2.login(f.emails.kitchen);
      const first = (await kitchen.get('/api/orders')).body.orders.find((o: any) => o.table_number === 1);
      await kitchen.post(`/api/order-status/${first.id}`, { to: 'em_preparacao' });
      expect((await place(c, f.table1.token, simple(f))).status).toBe(201);
    } finally {
      await t2.close();
    }
  });

  test('envios com menos de N segundos de intervalo são recusados, mas repetir a mesma chave não conta', async () => {
    const t2 = await startTestApp({ env: { MIN_SECONDS_BETWEEN_ORDERS: '1', MAX_PENDING_ORDERS_PER_TABLE: '50' } });
    try {
      const f = await seedFullRestaurant(t2, 'Rápido', 'r');
      const c = t2.anon('203.0.113.5');
      const key = uniqueKey();
      expect((await place(c, f.table1.token, simple(f), key)).status).toBe(201);
      const fast = await place(c, f.table1.token, simple(f));
      expect(fast.status).toBe(429);
      expect(fast.body.error.code).toBe('ORDERING_TOO_FAST');
      expect((await place(c, f.table1.token, simple(f), key)).status).toBe(200); // repetição legítima (rede lenta)
      await Bun.sleep(1100);
      expect((await place(c, f.table1.token, simple(f))).status).toBe(201);
    } finally {
      await t2.close();
    }
  });

  test('o limite de pedidos por atender é exato mesmo com muitos envios em paralelo', async () => {
    const t2 = await startTestApp({ env: { MAX_PENDING_ORDERS_PER_TABLE: '3' } });
    try {
      const f = await seedFullRestaurant(t2, 'Paralelo', 'p');
      const c = t2.anon('203.0.113.7');
      const results = await Promise.all(Array.from({ length: 15 }, () => place(c, f.table1.token, simple(f))));
      expect(tally(results)).toEqual({ '201 ok': 3, '429 TOO_MANY_PENDING_ORDERS': 12 });
      expect((await place(c, f.table2.token, simple(f))).status).toBe(201); // outra mesa não é afetada
    } finally {
      await t2.close();
    }
  });

  test('o intervalo mínimo entre pedidos também é exato em paralelo; repetições do mesmo envio não são recusadas', async () => {
    const t2 = await startTestApp({ env: { MIN_SECONDS_BETWEEN_ORDERS: '3', MAX_PENDING_ORDERS_PER_TABLE: '50' } });
    try {
      const f = await seedFullRestaurant(t2, 'Intervalo', 'i');
      const c = t2.anon('203.0.113.8');
      // 10 pedidos diferentes ao mesmo tempo na mesma mesa: só um passa
      expect(tally(await Promise.all(Array.from({ length: 10 }, () => place(c, f.table1.token, simple(f)))))).toEqual({ '201 ok': 1, '429 ORDERING_TOO_FAST': 9 });
      // o mesmo envio repetido ao mesmo tempo, mesa a mesa (mesas diferentes para o intervalo da ronda anterior não contar)
      const tables = [f.table2];
      for (let n = 3; n <= 16; n++) tables.push(await seedTable(t2, f.restaurantId, n));
      const total: Record<string, number> = {};
      for (const table of tables) {
        const key = uniqueKey();
        tally(await Promise.all(Array.from({ length: 8 }, () => place(c, table.token, simple(f), key))), total);
      }
      expect(total).toEqual({ '201 ok': tables.length, '200 ok': tables.length * 7 });
    } finally {
      await t2.close();
    }
  });

  test('limite por IP e por mesa nas rotas públicas (com limitação ligada)', async () => {
    const t2 = await startTestApp({ env: { RATE_LIMIT_ENABLED: 'true', MAX_PENDING_ORDERS_PER_TABLE: '100' } });
    try {
      const f = await seedFullRestaurant(t2, 'Spam', 's');
      // por mesa: 12 por minuto, mesmo vindo de IPs diferentes
      let blocked = 0;
      for (let i = 0; i < 16; i++) {
        const r = await place(new Client(t2.app, `198.51.100.${i + 1}`), f.table1.token, simple(f));
        if (r.status === 429) blocked++;
        else expect(r.status).toBe(201);
      }
      expect(blocked).toBe(4);
      // por IP: 40 pedidos por minuto em mesas diferentes... o menu tem o seu próprio limite alto
      const one = new Client(t2.app, '203.0.113.200');
      let ok = 0;
      let limited = 0;
      for (let i = 0; i < 45; i++) {
        const r = await place(one, i % 2 ? f.table1.token : f.table2.token, simple(f)); // 2 mesas: ainda vale o limite por IP
        if (r.status === 429) limited++;
        else ok++;
      }
      expect(limited).toBeGreaterThan(0);
      expect(ok).toBeLessThanOrEqual(40);
      const limitedRes = await place(one, f.table2.token, simple(f));
      expect(limitedRes.status).toBe(429);
      expect(limitedRes.body.error.code).toBe('RATE_LIMITED');
      expect(Number(limitedRes.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await t2.close();
    }
  });
});

describe('dados do pedido', () => {
  test('limites de tamanho: linhas, unidades, notas e extras', async () => {
    const c = t.anon('203.0.113.6');
    const line = (n = 1) => ({ menu_item_id: A.menu.sumo.id, quantity: n });
    expect((await place(c, A.table1.token, { items: Array.from({ length: 41 }, () => line()) })).status).toBe(400);
    expect((await place(c, A.table1.token, { items: Array.from({ length: 6 }, () => line(20)) })).status).toBe(400); // 120 unidades
    expect((await place(c, A.table1.token, simple(A, 1, { notes: 'x'.repeat(501) }))).status).toBe(400);
    expect((await place(c, A.table1.token, { items: [{ ...line(), notes: 'x'.repeat(301) }] })).status).toBe(400);
    expect((await place(c, A.table1.token, { items: [{ menu_item_id: A.menu.moamba.id, quantity: 1, options: [{ option_id: A.menu.extraOvo.id, quantity: 11 }] }] })).status).toBe(400);
    expect((await place(c, A.table1.token, { items: [{ menu_item_id: A.menu.moamba.id, quantity: 1, options: Array.from({ length: 16 }, () => ({ option_id: A.menu.extraOvo.id })) }] })).status).toBe(400);
    expect((await place(c, A.table1.token, { items: [{ menu_item_id: 'nao-e-uuid', quantity: 1 }] })).status).toBe(400);
    // 40 linhas e 100 unidades exatas são aceites
    expect((await place(c, A.table2.token, { items: Array.from({ length: 5 }, () => line(20)) })).status).toBe(201);
  });

  test('notas com acentos, emojis e HTML são guardadas tal como escritas e devolvidas como texto (JSON)', async () => {
    const c = t.anon('203.0.113.7');
    const notes = `<script>alert('xss')</script> "aspas" & ç ã é 🍗 \\ ' ; DROP TABLE orders; --`;
    const r = await place(c, A.table1.token, simple(A, 1, { notes }));
    expect(r.status).toBe(201);
    expect(r.body.order.notes).toBe(notes);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const n = await t.db.system(async (tx) => (await tx<{ n: number }>`SELECT count(*)::int AS n FROM orders`)[0]!.n);
    expect(n).toBeGreaterThan(0); // a tabela continua lá
  });

  test('caracteres nulos (\\u0000) não provocam erro 500', async () => {
    const c = t.anon('203.0.113.8');
    const r = await place(c, A.table1.token, simple(A, 1, { notes: 'olá\u0000mundo' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('o texto é aparado e notas vazias ficam sem valor', async () => {
    const c = t.anon('203.0.113.9');
    const r = await place(c, A.table1.token, simple(A, 1, { notes: '   ' }));
    expect(r.status).toBe(201);
    expect(r.body.order.notes).toBeNull();
  });
});

describe('mesa e restaurante indisponíveis', () => {
  test('mesa desativada → 403; restaurante em pausa → menu visível mas pedidos recusados; suspenso → 403', async () => {
    const f = await seedFullRestaurant(t, 'Estados', 'e');
    const c = t.anon('203.0.113.11');
    await t.db.system((tx) => tx`UPDATE restaurant_tables SET active = false WHERE id = ${f.table2.id}`);
    const off = await place(c, f.table2.token, simple(f));
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('TABLE_UNAVAILABLE');
    expect((await c.get(`/api/public/menu/${f.table2.token}`)).status).toBe(403);

    await t.db.system((tx) => tx`UPDATE restaurants SET accepting_orders = false WHERE id = ${f.restaurantId}`);
    const menu = await c.get(`/api/public/menu/${f.table1.token}`);
    expect(menu.status).toBe(200);
    expect(menu.body.accepting_orders).toBe(false);
    const paused = await place(c, f.table1.token, simple(f));
    expect(paused.status).toBe(409);
    expect(paused.body.error.code).toBe('NOT_ACCEPTING_ORDERS');

    await t.db.system((tx) => tx`UPDATE restaurants SET status = 'suspenso', accepting_orders = true WHERE id = ${f.restaurantId}`);
    const sus = await c.get(`/api/public/menu/${f.table1.token}`);
    expect(sus.status).toBe(403);
    expect(sus.body.error.code).toBe('RESTAURANT_UNAVAILABLE');
    expect((await place(c, f.table1.token, simple(f))).status).toBe(403);
  });

  test('mesmo com o pedido já feito, o acompanhamento por código continua a funcionar após pausa', async () => {
    const f = await seedFullRestaurant(t, 'Acompanha', 'ac');
    const c = t.anon('203.0.113.12');
    const o = (await place(c, f.table1.token, simple(f))).body.order;
    await t.db.system((tx) => tx`UPDATE restaurants SET accepting_orders = false WHERE id = ${f.restaurantId}`);
    expect((await c.get(`/api/public/orders/${o.public_code}`)).status).toBe(200);
  });
});

describe('pedidos registados pela equipa', () => {
  test('empregado e gerente registam pedidos presenciais; a cozinha não', async () => {
    const waiter = await t.login(A.emails.waiter);
    const manager = await t.login(A.emails.manager);
    const kitchen = await t.login(A.emails.kitchen);
    const body = { table_id: A.table1.id, ...orderBody(A.menu, { notes: 'Cliente ao balcão' }) };
    const w = await waiter.post('/api/orders', body);
    expect(w.status).toBe(201);
    expect(w.body.order.source).toBe('staff');
    expect(w.body.order.status).toBe('novo');
    expect(w.body.order.subtotal_cents).toBe(1_120_000);
    expect((await manager.post('/api/orders', body)).status).toBe(201);
    expect((await kitchen.post('/api/orders', body)).status).toBe(403);
    const by = await t.db.system(async (tx) => (await tx<{ created_by: string; source: string }>`SELECT created_by, source FROM orders WHERE id = ${w.body.order.id}`)[0]!);
    expect(by).toEqual({ created_by: A.userIds.waiter, source: 'staff' });
  });

  test('mesa de outro restaurante, inexistente ou desativada, e preços enviados são recusados', async () => {
    const waiter = await t.login(A.emails.waiter);
    expect((await waiter.post('/api/orders', { table_id: B.table1.id, ...simple(A) })).status).toBe(404);
    expect((await waiter.post('/api/orders', { table_id: '00000000-0000-4000-8000-000000000000', ...simple(A) })).status).toBe(404);
    expect((await waiter.post('/api/orders', { table_id: A.table1.id, items: [{ menu_item_id: A.menu.sumo.id, quantity: 1, price_cents: 1 }] })).status).toBe(400);
    expect((await waiter.post('/api/orders', { table_id: A.table1.id, items: [{ menu_item_id: B.menu.sumo.id, quantity: 1 }] })).status).toBe(422);
    expect((await waiter.post('/api/orders', { table_id: A.table1.id, items: [{ menu_item_id: A.menu.esgotado.id, quantity: 1 }] })).status).toBe(409);
  });
});

describe('pedidos presenciais sem duplicados (Idempotency-Key)', () => {
  const KEY = 'manual-order-key-0001-abcdefgh';

  test('repetir o mesmo envio devolve o pedido já criado, sem criar outro', async () => {
    const waiter = await t.login(A.emails.waiter);
    const body = { table_id: A.table1.id, ...simple(A) };
    const before = (await waiter.get('/api/orders?limit=200')).body.orders.length;
    const first = await waiter.post('/api/orders', body, { headers: { 'Idempotency-Key': KEY } });
    expect(first.status).toBe(201);
    const again = await waiter.post('/api/orders', body, { headers: { 'Idempotency-Key': KEY } });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.order.id).toBe(first.body.order.id);
    expect(again.body.order.order_number).toBe(first.body.order.order_number);
    const after = (await waiter.get('/api/orders?limit=200')).body.orders.length;
    expect(after).toBe(before + 1);
  });

  test('dois envios ao mesmo tempo com a mesma chave criam um só pedido', async () => {
    const waiter = await t.login(A.emails.waiter);
    const body = { table_id: A.table1.id, ...simple(A) };
    const key = 'manual-order-key-concurrent-0002';
    const before = (await waiter.get('/api/orders?limit=200')).body.orders.length;
    const results = await Promise.all([1, 2, 3, 4].map(() => waiter.post('/api/orders', body, { headers: { 'Idempotency-Key': key } })));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await waiter.get('/api/orders?limit=200')).body.orders.length).toBe(before + 1);
  });

  test('outra pessoa não consegue "repetir" a chave de um pedido que não é seu', async () => {
    const waiter = await t.login(A.emails.waiter);
    const manager = await t.login(A.emails.manager);
    const key = 'manual-order-key-owner-000003';
    const mine = await waiter.post('/api/orders', { table_id: A.table1.id, ...simple(A) }, { headers: { 'Idempotency-Key': key } });
    expect(mine.status).toBe(201);
    const theirs = await manager.post('/api/orders', { table_id: A.table1.id, ...simple(A) }, { headers: { 'Idempotency-Key': key } });
    expect(theirs.status).toBe(409);
    expect(theirs.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('a mesma chave em outro restaurante é independente', async () => {
    const waiter = await t.login(A.emails.waiter);
    const waiterB = await t.login(B.emails.waiter);
    const key = 'manual-order-key-tenants-00004';
    const a = await waiter.post('/api/orders', { table_id: A.table1.id, ...simple(A) }, { headers: { 'Idempotency-Key': key } });
    const b = await waiterB.post('/api/orders', { table_id: B.table1.id, ...simple(B) }, { headers: { 'Idempotency-Key': key } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.order.id).not.toBe(b.body.order.id);
  });

  test('chave inválida é recusada; sem chave continua a funcionar como antes', async () => {
    const waiter = await t.login(A.emails.waiter);
    const body = { table_id: A.table1.id, ...simple(A) };
    expect((await waiter.post('/api/orders', body, { headers: { 'Idempotency-Key': 'curta' } })).status).toBe(400);
    expect((await waiter.post('/api/orders', body, { headers: { 'Idempotency-Key': 'tem espaços e caracteres inválidos!!!' } })).status).toBe(400);
    expect((await waiter.post('/api/orders', body)).status).toBe(201);
  });
});

describe('listagens de pedidos', () => {
  test('filtros por âmbito, estado, mesa, limite e página (cursor)', async () => {
    const f = await seedFullRestaurant(t, 'Listas', 'li');
    const c = t.anon('203.0.113.13');
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push((await place(c, i < 3 ? f.table1.token : f.table2.token, simple(f))).body.order.public_code);
    const kitchen = await t.login(f.emails.kitchen);
    const manager = await t.login(f.emails.manager);
    const waiter = await t.login(f.emails.waiter);

    const active = await kitchen.get('/api/orders');
    expect(active.body.orders).toHaveLength(5);
    expect(active.body.orders.map((o: any) => o.order_number)).toEqual([1, 2, 3, 4, 5]); // mais antigos primeiro
    expect(typeof active.body.server_time).toBe('string');
    expect((await kitchen.get(`/api/orders?table_id=${f.table2.id}`)).body.orders).toHaveLength(2);
    expect((await kitchen.get('/api/orders?limit=2')).body.orders).toHaveLength(2);

    // levar dois pedidos até ao fim e cancelar um
    const ids = active.body.orders.map((o: any) => o.id);
    await kitchen.post(`/api/order-status/${ids[0]}`, { to: 'em_preparacao' });
    await kitchen.post(`/api/order-status/${ids[0]}`, { to: 'pronto' });
    await waiter.post(`/api/order-status/${ids[0]}`, { to: 'entregue' });
    await manager.post(`/api/order-status/${ids[1]}`, { to: 'cancelado', reason: 'Cliente saiu' });

    const hist = await manager.get('/api/orders?scope=history');
    expect(hist.body.orders.map((o: any) => o.status).sort()).toEqual(['cancelado', 'entregue']);
    expect(hist.body.orders[0].order_number).toBeGreaterThan(hist.body.orders[1].order_number); // mais recentes primeiro
    expect((await kitchen.get('/api/orders')).body.orders).toHaveLength(3);
    expect((await kitchen.get('/api/orders?status=entregue')).body.orders).toHaveLength(1);
    expect((await kitchen.get('/api/orders?status=novo,em_preparacao')).body.orders).toHaveLength(3);
    expect((await kitchen.get('/api/orders?status=inventado')).status).toBe(400);
    expect((await kitchen.get('/api/orders?limit=1000')).status).toBe(400);
    expect((await kitchen.get('/api/orders?before=ontem')).status).toBe(400);
    const page1 = await manager.get('/api/orders?scope=history&limit=1');
    const cursor = page1.body.orders[0].created_at;
    const page2 = await manager.get(`/api/orders?scope=history&limit=5&before=${encodeURIComponent(cursor)}`);
    expect(page2.body.orders.length).toBe(1);
    expect(page2.body.orders[0].id).not.toBe(page1.body.orders[0].id);
    void codes;
  });
});

describe('tempo real (SSE)', () => {
  async function readEvents(res: Response, count: number, timeoutMs = 3000): Promise<string[]> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const events: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (events.length < count && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - Date.now())).then(() => ({ value: undefined, done: true as const })),
      ]);
      if (done || !value) break;
      buf += dec.decode(value);
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = block.split('\n').find((l) => l.startsWith('event: '));
        if (ev) events.push(block);
      }
    }
    await reader.cancel().catch(() => undefined);
    return events;
  }

  test('o cliente recebe o estado atual e depois cada mudança do seu pedido', async () => {
    const c = t.anon('203.0.113.20');
    const code = (await place(c, A.table1.token, simple(A))).body.order.public_code;
    const ac = new AbortController();
    const stream = await c.request('GET', `/api/public/orders/${code}/stream`, { keepOpen: true, signal: ac.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toContain('no-store');

    const kitchen = await t.login(A.emails.kitchen);
    const id = (await kitchen.get('/api/orders')).body.orders.find((o: any) => o.public_code === undefined && true)?.id;
    void id;
    const orderId = await t.db.system(async (tx) => (await tx<{ id: string }>`SELECT id FROM orders WHERE public_code = ${code}`)[0]!.id);
    const collecting = readEvents(stream.res, 3);
    await Bun.sleep(50);
    await kitchen.post(`/api/order-status/${orderId}`, { to: 'em_preparacao' });
    await kitchen.post(`/api/order-status/${orderId}`, { to: 'pronto' });
    const events = await collecting;
    ac.abort();
    expect(events).toHaveLength(3);
    const states = events.map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).status);
    expect(states).toEqual(['novo', 'em_preparacao', 'pronto']);
  });

  test('a ligação em tempo real da equipa exige sessão e só traz avisos do próprio restaurante', async () => {
    expect((await t.anon().get('/api/realtime/stream')).status).toBe(401);
    const kitchenA = await t.login(A.emails.kitchen);
    const kitchenB = await t.login(B.emails.kitchen);
    const sA = await kitchenA.request('GET', '/api/realtime/stream', { keepOpen: true });
    const sB = await kitchenB.request('GET', '/api/realtime/stream', { keepOpen: true });
    expect(sA.status).toBe(200);
    const collectA = readEvents(sA.res, 2, 2000);
    const collectB = readEvents(sB.res, 2, 1000);
    await Bun.sleep(50);
    const r = await place(t.anon('203.0.113.21'), A.table1.token, simple(A));
    expect(r.status).toBe(201);
    const evA = await collectA;
    const evB = await collectB;
    expect(evA.map((e) => e.split('\n').find((l) => l.startsWith('event: '))!.slice(7))).toEqual(['hello', 'order.created']);
    expect(evB.map((e) => e.split('\n').find((l) => l.startsWith('event: '))!.slice(7))).toEqual(['hello']); // B só recebe o "hello"
    // os avisos não contêm dados pessoais nem valores
    const created = JSON.parse(evA[1]!.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
    expect(Object.keys(created).sort()).toEqual(['at', 'order_id', 'order_number', 'table_number', 'type']);
  });
});
