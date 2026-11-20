// Fluxo principal de ponta a ponta (sem rede): QR Code → menu → pedido → cozinha → empregado.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, orderBody, seedFullRestaurant, startTestApp, uniqueKey, type TestApp } from './helpers';

let t: TestApp;
let a: Awaited<ReturnType<typeof seedFullRestaurant>>;
let b: Awaited<ReturnType<typeof seedFullRestaurant>>;
let customer: Client;

beforeAll(async () => {
  t = await startTestApp();
  a = await seedFullRestaurant(t, 'Terraza A', 'a', { feeBps: 1000 });
  b = await seedFullRestaurant(t, 'Restaurante B', 'b');
  customer = t.anon('203.0.113.10');
});
afterAll(async () => {
  await t.close();
});

describe('menu público (QR Code)', () => {
  test('mostra só pratos ativos de categorias ativas; esgotados aparecem como indisponíveis', async () => {
    const r = await customer.get(`/api/public/menu/${a.table1.token}`);
    expect(r.status).toBe(200);
    expect(r.body.restaurant.name).toBe('Terraza A');
    expect(r.body.table.number).toBe(1);
    expect(r.body.accepting_orders).toBe(true);
    const names = r.body.categories.flatMap((c: any) => c.items.map((i: any) => i.name));
    expect(names).toContain('Muamba de galinha');
    expect(names).toContain('Calulu (esgotado)');
    expect(names).not.toContain('Prato desativado');
    expect(names).not.toContain('Prato da categoria escondida');
    const calulu = r.body.categories[0].items.find((i: any) => i.name.startsWith('Calulu'));
    expect(calulu.available).toBe(false);
    const muamba = r.body.categories[0].items.find((i: any) => i.name.startsWith('Muamba'));
    expect(muamba.options.map((o: any) => o.name)).toEqual(['Ovo estrelado']);
    // nunca expõe dados internos
    expect(JSON.stringify(r.body)).not.toContain(a.restaurantId);
    expect(JSON.stringify(r.body)).not.toContain(a.table1.token);
  });

  test('token inválido ou desconhecido → 404 sem revelar nada', async () => {
    expect((await customer.get('/api/public/menu/curto')).status).toBe(404);
    const r = await customer.get('/api/public/menu/' + 'x'.repeat(22));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('TABLE_NOT_FOUND');
  });
});

describe('criação de pedidos', () => {
  let order: any;
  const key = uniqueKey();

  test('o servidor calcula preços e totais (subtotal, taxa de serviço, total)', async () => {
    const r = await customer.post(`/api/public/menu/${a.table1.token}/orders`, orderBody(a.menu, { notes: 'Sem picante' }), { headers: { 'idempotency-key': key } });
    expect(r.status).toBe(201);
    order = r.body.order;
    expect(r.body.replayed).toBe(false);
    // (4500+500)*2 + 1200 = 11 200 Kz = 1 120 000 cêntimos; taxa 10 % = 112 000
    expect(order.subtotal_cents).toBe(1_120_000);
    expect(order.service_fee_cents).toBe(112_000);
    expect(order.total_cents).toBe(1_232_000);
    expect(order.status).toBe('novo');
    expect(order.table_number).toBe(1);
    expect(order.order_number).toBe(1);
    expect(order.items).toHaveLength(2);
    expect(order.items[0].options[0].name).toBe('Ovo estrelado');
    expect(order.notes).toBe('Sem picante');
    expect(order.public_code.length).toBeGreaterThanOrEqual(22);
  });

  test('repetir o mesmo envio (mesma chave) devolve o mesmo pedido e não cria outro', async () => {
    const r = await customer.post(`/api/public/menu/${a.table1.token}/orders`, orderBody(a.menu), { headers: { 'idempotency-key': key } });
    expect(r.status).toBe(200);
    expect(r.body.replayed).toBe(true);
    expect(r.body.order.public_code).toBe(order.public_code);
    const n = await t.db.system(async (tx) => (await tx<{ n: number }>`SELECT count(*)::int AS n FROM orders WHERE restaurant_id = ${a.restaurantId}`)[0]!.n);
    expect(n).toBe(1);
  });

  test('exige o cabeçalho Idempotency-Key', async () => {
    const r = await customer.post(`/api/public/menu/${a.table1.token}/orders`, orderBody(a.menu));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test('preços enviados pelo cliente são recusados (o servidor nunca os aceita)', async () => {
    const body = { items: [{ menu_item_id: a.menu.moamba.id, quantity: 1, price_cents: 1 }] };
    const r = await customer.post(`/api/public/menu/${a.table1.token}/orders`, body, { headers: { 'idempotency-key': uniqueKey() } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    const r2 = await customer.post(`/api/public/menu/${a.table1.token}/orders`, { ...orderBody(a.menu), total_cents: 1 }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(r2.status).toBe(400);
  });

  test('prato esgotado → 409 ITEM_UNAVAILABLE', async () => {
    const r = await customer.post(`/api/public/menu/${a.table1.token}/orders`, { items: [{ menu_item_id: a.menu.esgotado.id, quantity: 1 }] }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ITEM_UNAVAILABLE');
    expect(r.body.error.details.items[0].name).toContain('Calulu');
  });

  test('prato desativado, de categoria escondida, de outro restaurante ou extra inativo → 422', async () => {
    const post = (items: unknown[]) => customer.post(`/api/public/menu/${a.table1.token}/orders`, { items }, { headers: { 'idempotency-key': uniqueKey() } });
    expect((await post([{ menu_item_id: a.menu.inativo.id, quantity: 1 }])).body.error.code).toBe('ITEM_NOT_FOUND');
    expect((await post([{ menu_item_id: a.menu.escondido.id, quantity: 1 }])).body.error.code).toBe('ITEM_NOT_FOUND');
    expect((await post([{ menu_item_id: b.menu.moamba.id, quantity: 1 }])).body.error.code).toBe('ITEM_NOT_FOUND');
    expect((await post([{ menu_item_id: a.menu.moamba.id, quantity: 1, options: [{ option_id: a.menu.extraInativo.id }] }])).body.error.code).toBe('OPTION_NOT_FOUND');
    // extra de outro prato
    expect((await post([{ menu_item_id: a.menu.sumo.id, quantity: 1, options: [{ option_id: a.menu.extraOvo.id }] }])).body.error.code).toBe('OPTION_NOT_FOUND');
  });

  test('quantidades inválidas → 400', async () => {
    const post = (items: unknown[]) => customer.post(`/api/public/menu/${a.table1.token}/orders`, { items }, { headers: { 'idempotency-key': uniqueKey() } });
    expect((await post([{ menu_item_id: a.menu.moamba.id, quantity: 0 }])).status).toBe(400);
    expect((await post([{ menu_item_id: a.menu.moamba.id, quantity: 21 }])).status).toBe(400);
    expect((await post([{ menu_item_id: a.menu.moamba.id, quantity: 1.5 }])).status).toBe(400);
    expect((await post([])).status).toBe(400);
  });

  test('o cliente acompanha o pedido pelo código e vê o histórico da mesa', async () => {
    const r = await customer.get(`/api/public/orders/${order.public_code}`);
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('novo');
    expect(r.body.order.restaurant_name).toBe('Terraza A');
    expect(r.body.order).toHaveProperty('accent_color');
    const h = await customer.get(`/api/public/menu/${a.table1.token}/orders`);
    expect(h.status).toBe(200);
    expect(h.body.orders).toHaveLength(1);
    expect(h.body.orders[0].public_code).toBe(order.public_code);
    // outra mesa não vê este histórico
    const other = await customer.get(`/api/public/menu/${a.table2.token}/orders`);
    expect(other.body.orders).toHaveLength(0);
  });

  test('código de pedido inválido → 404', async () => {
    expect((await customer.get('/api/public/orders/' + 'y'.repeat(22))).status).toBe(404);
    expect((await customer.get('/api/public/orders/abc')).status).toBe(404);
  });
});

describe('cozinha e empregado', () => {
  let kitchen: Client;
  let waiter: Client;
  let manager: Client;
  let orderId: string;
  let publicCode: string;

  beforeAll(async () => {
    kitchen = await t.login(a.emails.kitchen);
    waiter = await t.login(a.emails.waiter);
    manager = await t.login(a.emails.manager);
    const r = await kitchen.get('/api/orders');
    orderId = r.body.orders[0].id;
    publicCode = (await t.db.system(async (tx) => (await tx<{ c: string }>`SELECT public_code AS c FROM orders WHERE id = ${orderId}`)[0]!.c));
  });

  test('a cozinha vê os pedidos novos do seu restaurante', async () => {
    const r = await kitchen.get('/api/orders');
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(1);
    expect(r.body.orders[0].status).toBe('novo');
    expect(r.body.orders[0].items.length).toBe(2);
  });

  test('o empregado não pode começar a preparar; a cozinha não pode entregar', async () => {
    const w = await waiter.post(`/api/order-status/${orderId}`, { to: 'em_preparacao' });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe('TRANSITION_NOT_ALLOWED');
    const k = await kitchen.post(`/api/order-status/${orderId}`, { to: 'entregue' });
    expect(k.status).toBe(409);
    expect(k.body.error.code).toBe('INVALID_TRANSITION');
  });

  test('novo → em preparação → pronto → entregue, com histórico e avisos em tempo real', async () => {
    const events: any[] = [];
    const unsub = t.deps.hub.subscribeRestaurant(a.restaurantId, (e) => events.push(e));
    const pub: any[] = [];
    const unsub2 = t.deps.hub.subscribeOrder(publicCode, (e) => pub.push(e));

    let r = await kitchen.post(`/api/order-status/${orderId}`, { to: 'em_preparacao', from: 'novo' });
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('em_preparacao');
    expect(r.body.order.preparing_at).not.toBeNull();

    r = await kitchen.post(`/api/order-status/${orderId}`, { to: 'pronto', from: 'em_preparacao' });
    expect(r.body.order.status).toBe('pronto');
    expect(r.body.order.ready_at).not.toBeNull();

    // estado do cliente
    expect((await customer.get(`/api/public/orders/${publicCode}`)).body.order.status).toBe('pronto');

    r = await waiter.post(`/api/order-status/${orderId}`, { to: 'entregue', from: 'pronto' });
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('entregue');
    expect(r.body.order.delivered_at).not.toBeNull();

    unsub();
    unsub2();
    expect(events.map((e) => e.type)).toEqual(['order.status', 'order.status', 'order.status']);
    expect(events.map((e) => e.to)).toEqual(['em_preparacao', 'pronto', 'entregue']);
    expect(pub.map((e) => e.status)).toEqual(['em_preparacao', 'pronto', 'entregue']);

    const d = await manager.get(`/api/orders/${orderId}`);
    expect(d.status).toBe(200);
    expect(d.body.history.map((h: any) => h.new_status)).toEqual(['novo', 'em_preparacao', 'pronto', 'entregue']);
    expect(d.body.history.map((h: any) => h.changed_by_role)).toEqual(['public', 'kitchen', 'kitchen', 'waiter']);
  });

  test('conflito entre dois painéis: "from" desatualizado → 409 STATE_CONFLICT', async () => {
    const r = await kitchen.post(`/api/order-status/${orderId}`, { to: 'pronto', from: 'em_preparacao' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STATE_CONFLICT');
    expect(r.body.error.details.current).toBe('entregue');
  });

  test('cancelar exige motivo e só o gerente pode', async () => {
    const created = await customer.post(`/api/public/menu/${a.table2.token}/orders`, orderBody(a.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect(created.status).toBe(201);
    const id = (await manager.get('/api/orders')).body.orders.find((o: any) => o.table_number === 2).id;
    expect((await kitchen.post(`/api/order-status/${id}`, { to: 'cancelado', reason: 'tentativa' })).status).toBe(403);
    expect((await waiter.post(`/api/order-status/${id}`, { to: 'cancelado', reason: 'tentativa' })).status).toBe(403);
    const noReason = await manager.post(`/api/order-status/${id}`, { to: 'cancelado' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const ok = await manager.post(`/api/order-status/${id}`, { to: 'cancelado', reason: 'Cliente desistiu' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.status).toBe('cancelado');
    expect(ok.body.order.cancel_reason).toBe('Cliente desistiu');
    const audit = await t.db.system(async (tx) => tx<{ action: string }>`SELECT action FROM audit_logs WHERE entity_id = ${id}`);
    expect(audit.map((x) => x.action)).toContain('order.cancel');
  });
});

describe('isolamento entre restaurantes', () => {
  test('a cozinha do restaurante B não vê nem altera pedidos do restaurante A', async () => {
    const kitchenB = await t.login(b.emails.kitchen);
    const list = await kitchenB.get('/api/orders?scope=history');
    expect(list.status).toBe(200);
    expect(list.body.orders).toHaveLength(0);
    const idA = await t.db.system(async (tx) => (await tx<{ id: string }>`SELECT id FROM orders WHERE restaurant_id = ${a.restaurantId} LIMIT 1`)[0]!.id);
    expect((await kitchenB.get(`/api/orders/${idA}`)).status).toBe(404);
    expect((await kitchenB.post(`/api/order-status/${idA}`, { to: 'em_preparacao' })).status).toBe(404);
  });

  test('o token de uma mesa só serve para o restaurante dessa mesa', async () => {
    const r = await customer.get(`/api/public/menu/${b.table1.token}`);
    expect(r.body.restaurant.name).toBe('Restaurante B');
  });
});
