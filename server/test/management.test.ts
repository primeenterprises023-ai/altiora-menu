// Gestão pelo gerente: menu, mesas e QR Codes, definições do restaurante; e pela plataforma: criar/suspender restaurantes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, ORIGIN, orderBody, seedFullRestaurant, seedPlatformAdmin, startTestApp, uniqueKey, type TestApp } from './helpers';

let t: TestApp;
let A: Awaited<ReturnType<typeof seedFullRestaurant>>;
let B: Awaited<ReturnType<typeof seedFullRestaurant>>;
let manager: Client;
let managerB: Client;
let kitchen: Client;
let waiter: Client;
let customer: Client;

beforeAll(async () => {
  t = await startTestApp();
  A = await seedFullRestaurant(t, 'Terraza A', 'a', { feeBps: 1000 });
  B = await seedFullRestaurant(t, 'Restaurante B', 'b');
  await seedPlatformAdmin(t);
  manager = await t.login(A.emails.manager);
  managerB = await t.login(B.emails.manager);
  kitchen = await t.login(A.emails.kitchen);
  waiter = await t.login(A.emails.waiter);
  customer = t.anon('203.0.113.30');
});
afterAll(async () => {
  await t.close();
});

const auditActions = (rid: string) => t.db.system(async (tx) => (await tx<{ action: string }>`SELECT action FROM audit_logs WHERE restaurant_id = ${rid} ORDER BY id`).map((r) => r.action));

describe('menu: categorias, pratos e extras', () => {
  let catId: string;
  let itemId: string;

  test('só o gerente cria categorias; nomes repetidos (sem distinguir maiúsculas) são recusados', async () => {
    for (const c of [kitchen, waiter, customer]) expect([401, 403]).toContain((await c.post('/api/menu/categories', { name: 'Sobremesas' })).status);
    const r = await manager.post('/api/menu/categories', { name: 'Sobremesas', display_order: 5 });
    expect(r.status).toBe(201);
    catId = r.body.category.id;
    expect(r.body.category).toMatchObject({ name: 'Sobremesas', display_order: 5, active: true, items: [] });
    const dup = await manager.post('/api/menu/categories', { name: 'SOBREMESAS' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('categoria');
    // outro restaurante pode ter o mesmo nome
    expect((await managerB.post('/api/menu/categories', { name: 'Sobremesas' })).status).toBe(201);
  });

  test('criar prato: preço em cêntimos inteiros, endereço de imagem seguro, textos aparados', async () => {
    const r = await manager.post('/api/menu/items', {
      category_id: catId, name: '  Pudim de leite  ', description: '  Receita da casa  ', image_url: 'https://exemplo.ao/pudim.jpg', price_cents: 150000,
    });
    expect(r.status).toBe(201);
    itemId = r.body.item.id;
    expect(r.body.item).toMatchObject({ name: 'Pudim de leite', description: 'Receita da casa', price_cents: 150000, available: true, active: true, options: [] });
    const bad = (over: Record<string, unknown>) => manager.post('/api/menu/items', { category_id: catId, name: 'X', price_cents: 100, ...over });
    expect((await bad({ price_cents: -1 })).status).toBe(400);
    expect((await bad({ price_cents: 10.5 })).status).toBe(400);
    expect((await bad({ price_cents: '100' })).status).toBe(400);
    expect((await bad({ price_cents: 1e12 })).status).toBe(400);
    expect((await bad({ name: '   ' })).status).toBe(400);
    expect((await bad({ name: 'x'.repeat(121) })).status).toBe(400);
    expect((await bad({ image_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await bad({ image_url: 'http://inseguro.ao/a.jpg' })).status).toBe(400);
    expect((await bad({ image_url: 'data:image/png;base64,AAAA' })).status).toBe(400);
    expect((await bad({ image_url: '//outro.site/a.jpg' })).status).toBe(400);
    expect((await bad({ image_url: '/imagens/prato.jpg' })).status).toBe(201);
    expect((await bad({ category_id: B.menu.categoryId })).status).toBe(404); // categoria de outro restaurante
    expect((await bad({ id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400); // campos desconhecidos
  });

  test('editar prato: só os campos enviados mudam; "" apaga a descrição; corpo vazio é recusado', async () => {
    const r1 = await manager.patch(`/api/menu/items/${itemId}`, { price_cents: 175000 });
    expect(r1.status).toBe(200);
    expect(r1.body.item).toMatchObject({ price_cents: 175000, name: 'Pudim de leite', description: 'Receita da casa', image_url: 'https://exemplo.ao/pudim.jpg' });
    const r2 = await manager.patch(`/api/menu/items/${itemId}`, { description: '', image_url: null });
    expect(r2.body.item.description).toBeNull();
    expect(r2.body.item.image_url).toBeNull();
    expect(r2.body.item.name).toBe('Pudim de leite');
    expect((await manager.patch(`/api/menu/items/${itemId}`, {})).status).toBe(400);
    expect((await manager.patch(`/api/menu/items/${itemId}`, { restaurant_id: B.restaurantId })).status).toBe(400);
    expect((await manager.patch(`/api/menu/items/${itemId}`, { category_id: B.menu.categoryId })).status).toBe(404);
    expect((await manager.patch('/api/menu/items/nao-uuid', { name: 'x' })).status).toBe(404);
    expect((await manager.patch('/api/menu/items/00000000-0000-4000-8000-000000000000', { name: 'x' })).status).toBe(404);
    // a alteração de preço fica na auditoria com o valor anterior e o novo
    const [row] = await t.db.system((tx) => tx<{ metadata: { price_change?: { from: number; to: number } } }>`
      SELECT metadata FROM audit_logs WHERE entity_id = ${itemId} AND action = 'menu.item.update' ORDER BY id LIMIT 1`);
    expect(row!.metadata.price_change).toEqual({ from: 150000, to: 175000 });
  });

  test('extras: criar, editar, desativar e apagar', async () => {
    const r = await manager.post(`/api/menu/items/${itemId}/options`, { name: 'Calda de caramelo', price_delta_cents: 20000 });
    expect(r.status).toBe(201);
    const optId = r.body.option.id;
    expect((await manager.post(`/api/menu/items/${itemId}/options`, { name: 'Grátis' })).body.option.price_delta_cents).toBe(0);
    expect((await manager.post(`/api/menu/items/${itemId}/options`, { name: 'Negativo', price_delta_cents: -5 })).status).toBe(400);
    expect((await manager.post('/api/menu/items/00000000-0000-4000-8000-000000000000/options', { name: 'X' })).status).toBe(404);
    expect((await manager.patch(`/api/menu/options/${optId}`, { price_delta_cents: 25000 })).body.option.price_delta_cents).toBe(25000);
    // extra desativado deixa de aparecer ao cliente
    await manager.patch(`/api/menu/options/${optId}`, { active: false });
    const menu = await customer.get(`/api/public/menu/${A.table1.token}`);
    const pudim = menu.body.categories.flatMap((c: any) => c.items).find((i: any) => i.name === 'Pudim de leite');
    expect(pudim.options.map((o: any) => o.name)).toEqual(['Grátis']);
    expect((await manager.delete(`/api/menu/options/${optId}`)).status).toBe(204);
    expect((await manager.delete(`/api/menu/options/${optId}`)).status).toBe(404);
  });

  test('"esgotado": a cozinha e o gerente alteram a disponibilidade; o empregado não; o cliente vê e não consegue pedir', async () => {
    expect((await waiter.patch(`/api/menu/items/${itemId}/availability`, { available: false })).status).toBe(403);
    const r = await kitchen.patch(`/api/menu/items/${itemId}/availability`, { available: false });
    expect(r.status).toBe(200);
    expect(r.body.item.available).toBe(false);
    const menu = await customer.get(`/api/public/menu/${A.table1.token}`);
    const pudim = menu.body.categories.flatMap((c: any) => c.items).find((i: any) => i.name === 'Pudim de leite');
    expect(pudim.available).toBe(false);
    const order = await customer.post(`/api/public/menu/${A.table1.token}/orders`, { items: [{ menu_item_id: itemId, quantity: 1 }] }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(order.status).toBe(409);
    expect(order.body.error.code).toBe('ITEM_UNAVAILABLE');
    expect((await kitchen.patch(`/api/menu/items/${itemId}`, { price_cents: 1 })).status).toBe(403); // cozinha não edita preços
    expect((await kitchen.patch(`/api/menu/items/${B.menu.sumo.id}/availability`, { available: false })).status).toBe(404); // nem de outro restaurante
    expect((await manager.patch(`/api/menu/items/${itemId}/availability`, { available: true })).body.item.available).toBe(true);
    expect((await kitchen.patch(`/api/menu/items/${itemId}/availability`, { available: 'sim' })).status).toBe(400);
  });

  test('o menu da equipa inclui o que está desativado; cozinha e empregado só leem', async () => {
    await manager.patch(`/api/menu/items/${A.menu.sumo.id}`, { active: false });
    for (const c of [manager, kitchen, waiter]) {
      const r = await c.get('/api/menu');
      expect(r.status).toBe(200);
      const items = r.body.categories.flatMap((cat: any) => cat.items);
      expect(items.find((i: any) => i.id === A.menu.sumo.id).active).toBe(false);
      expect(r.body.categories.some((cat: any) => cat.active === false)).toBe(true);
    }
    const pub = await customer.get(`/api/public/menu/${A.table1.token}`);
    expect(pub.body.categories.flatMap((c: any) => c.items).some((i: any) => i.id === A.menu.sumo.id)).toBe(false);
    await manager.patch(`/api/menu/items/${A.menu.sumo.id}`, { active: true });
  });

  test('alterar o preço não mexe em pedidos antigos (cópia do nome e do preço) mas vale para os novos', async () => {
    const before = await customer.post(`/api/public/menu/${A.table2.token}/orders`, { items: [{ menu_item_id: A.menu.moamba.id, quantity: 1 }] }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(before.body.order.subtotal_cents).toBe(450000);
    await manager.patch(`/api/menu/items/${A.menu.moamba.id}`, { name: 'Muamba nova', price_cents: 500000 });
    const old = await customer.get(`/api/public/orders/${before.body.order.public_code}`);
    expect(old.body.order.subtotal_cents).toBe(450000);
    expect(old.body.order.items[0].name).toBe('Muamba de galinha');
    const after = await customer.post(`/api/public/menu/${A.table2.token}/orders`, { items: [{ menu_item_id: A.menu.moamba.id, quantity: 1 }] }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(after.body.order.subtotal_cents).toBe(500000);
    expect(after.body.order.items[0].name).toBe('Muamba nova');
    // apagar o prato mantém o histórico dos pedidos
    const extra = await manager.post('/api/menu/items', { category_id: catId, name: 'Prato efémero', price_cents: 1000 });
    const o = await customer.post(`/api/public/menu/${A.table2.token}/orders`, { items: [{ menu_item_id: extra.body.item.id, quantity: 2 }] }, { headers: { 'idempotency-key': uniqueKey() } });
    expect((await manager.delete(`/api/menu/items/${extra.body.item.id}`)).status).toBe(204);
    const kept = await customer.get(`/api/public/orders/${o.body.order.public_code}`);
    expect(kept.body.order.items[0]).toMatchObject({ name: 'Prato efémero', quantity: 2, unit_price_cents: 1000, line_total_cents: 2000 });
    await manager.patch(`/api/menu/items/${A.menu.moamba.id}`, { name: 'Muamba de galinha', price_cents: 450000 });
  });

  test('categoria com pratos não se apaga; vazia apaga-se; o gerente de B não mexe no menu de A', async () => {
    const blocked = await manager.delete(`/api/menu/categories/${catId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CATEGORY_NOT_EMPTY');
    const empty = await manager.post('/api/menu/categories', { name: 'Temporária' });
    expect((await manager.delete(`/api/menu/categories/${empty.body.category.id}`)).status).toBe(204);
    expect((await managerB.patch(`/api/menu/categories/${catId}`, { name: 'Hack' })).status).toBe(404);
    expect((await managerB.delete(`/api/menu/categories/${catId}`)).status).toBe(404);
    expect((await managerB.patch(`/api/menu/items/${itemId}`, { name: 'Hack' })).status).toBe(404);
    expect((await managerB.delete(`/api/menu/items/${itemId}`)).status).toBe(404);
    expect((await managerB.patch(`/api/menu/items/${itemId}/availability`, { available: false })).status).toBe(404);
    expect((await managerB.post(`/api/menu/items/${itemId}/options`, { name: 'Hack' })).status).toBe(404);
    const stillThere = (await manager.get('/api/menu')).body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === itemId);
    expect(stillThere.name).toBe('Pudim de leite');
  });

  test('as alterações ficam na auditoria e avisam os painéis em tempo real', async () => {
    const events: any[] = [];
    const off = t.deps.hub.subscribeRestaurant(A.restaurantId, (e) => events.push(e));
    await manager.patch(`/api/menu/items/${itemId}`, { display_order: 3 });
    await kitchen.patch(`/api/menu/items/${itemId}/availability`, { available: true });
    off();
    expect(events.map((e) => e.type)).toEqual(['menu.changed', 'menu.changed']);
    const actions = await auditActions(A.restaurantId);
    for (const a of ['menu.category.create', 'menu.item.create', 'menu.item.update', 'menu.item.availability', 'menu.option.create', 'menu.option.update', 'menu.option.delete', 'menu.item.delete', 'menu.category.delete']) {
      expect(actions).toContain(a);
    }
  });

  test('o menu público respeita a ordem de apresentação', async () => {
    const f = await seedFullRestaurant(t, 'Ordem', 'o');
    const m = await t.login(f.emails.manager);
    const c1 = (await m.post('/api/menu/categories', { name: 'Zzz primeiro', display_order: 1 })).body.category.id;
    const c2 = (await m.post('/api/menu/categories', { name: 'Aaa segundo', display_order: 2 })).body.category.id;
    await m.post('/api/menu/items', { category_id: c1, name: 'B prato', price_cents: 100, display_order: 2 });
    await m.post('/api/menu/items', { category_id: c1, name: 'A prato', price_cents: 100, display_order: 2 });
    await m.post('/api/menu/items', { category_id: c1, name: 'C prato', price_cents: 100, display_order: 1 });
    await m.post('/api/menu/items', { category_id: c2, name: 'D prato', price_cents: 100 });
    const menu = await t.anon().get(`/api/public/menu/${f.table1.token}`);
    const names = menu.body.categories.map((c: any) => c.name);
    expect(names).toEqual(['Pratos', 'Zzz primeiro', 'Aaa segundo']); // ordem de apresentação, não alfabética; a categoria desativada não aparece
    const first = menu.body.categories.find((c: any) => c.name === 'Zzz primeiro');
    expect(first.items.map((i: any) => i.name)).toEqual(['C prato', 'A prato', 'B prato']);
  });
});

describe('mesas e QR Codes', () => {
  test('o gerente cria mesas com um token secreto aleatório; o endereço do QR usa o domínio configurado', async () => {
    const r = await manager.post('/api/tables', { table_number: 10, label: 'Varanda' });
    expect(r.status).toBe(201);
    expect(r.body.table).toMatchObject({ table_number: 10, label: 'Varanda', active: true, active_orders: 0, ready_orders: 0 });
    expect(r.body.table.qr_url).toMatch(new RegExp(`^${ORIGIN}/menu/[A-Za-z0-9_-]{22}$`));
    const token = r.body.table.qr_url.split('/').pop();
    const menu = await customer.get(`/api/public/menu/${token}`);
    expect(menu.status).toBe(200);
    expect(menu.body.table).toEqual({ number: 10, label: 'Varanda' });
    // endereço próprio do restaurante (definido pela plataforma)
    await t.db.system((tx) => tx`UPDATE restaurants SET menu_base_url = 'https://menu.terraza.ao' WHERE id = ${A.restaurantId}`);
    const list = await manager.get('/api/tables');
    expect(list.body.tables.find((x: any) => x.table_number === 10).qr_url).toBe(`https://menu.terraza.ao/menu/${token}`);
    await t.db.system((tx) => tx`UPDATE restaurants SET menu_base_url = NULL WHERE id = ${A.restaurantId}`);
  });

  test('números repetidos ou inválidos são recusados; os tokens nunca se repetem', async () => {
    expect((await manager.post('/api/tables', { table_number: 10 })).status).toBe(409);
    for (const n of [0, -1, 10000, 1.5, '7', null]) expect({ n, status: (await manager.post('/api/tables', { table_number: n })).status }).toEqual({ n, status: 400 });
    expect((await manager.post('/api/tables', { table_number: 11, label: 'x'.repeat(61) })).status).toBe(400);
    const tokens = new Set<string>();
    for (let i = 100; i < 140; i++) {
      const r = await manager.post('/api/tables', { table_number: i });
      tokens.add(r.body.table.qr_url.split('/').pop());
    }
    expect(tokens.size).toBe(40);
  });

  test('cozinha e empregado veem as mesas mas nunca os endereços/tokens dos QR Codes', async () => {
    for (const c of [kitchen, waiter]) {
      const r = await c.get('/api/tables');
      expect(r.status).toBe(200);
      expect(r.body.tables.length).toBeGreaterThan(2);
      expect(JSON.stringify(r.body)).not.toContain('qr_');
      expect(JSON.stringify(r.body)).not.toContain('/menu/');
    }
    expect((await kitchen.post('/api/tables', { table_number: 500 })).status).toBe(403);
    expect((await waiter.post('/api/tables', { table_number: 500 })).status).toBe(403);
    expect((await managerB.get('/api/tables')).body.tables.every((x: any) => x.table_number <= 2)).toBe(true);
  });

  test('revogar o QR Code: o antigo deixa de funcionar de imediato e o histórico da mesa recomeça', async () => {
    const f = await seedFullRestaurant(t, 'Revoga', 'rv');
    const m = await t.login(f.emails.manager);
    const c = t.anon('203.0.113.31');
    const o = await c.post(`/api/public/menu/${f.table1.token}/orders`, orderBody(f.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect(o.status).toBe(201);
    expect((await c.get(`/api/public/menu/${f.table1.token}/orders`)).body.orders).toHaveLength(1);

    const r = await m.post(`/api/tables/${f.table1.id}/regenerate-qr`);
    expect(r.status).toBe(200);
    const newToken = r.body.table.qr_url.split('/').pop();
    expect(newToken).not.toBe(f.table1.token);
    const old = await c.get(`/api/public/menu/${f.table1.token}`);
    expect(old.status).toBe(404);
    expect((await c.request('POST', `/api/public/menu/${f.table1.token}/orders`, { json: orderBody(f.menu), headers: { 'idempotency-key': uniqueKey() } })).status).toBe(404);
    expect((await c.get(`/api/public/menu/${newToken}`)).status).toBe(200);
    expect((await c.get(`/api/public/menu/${newToken}/orders`)).body.orders).toHaveLength(0);
    // o pedido já feito continua acompanhável pelo seu próprio código
    expect((await c.get(`/api/public/orders/${o.body.order.public_code}`)).status).toBe(200);
    // só o gerente revoga
    const w = await t.login(f.emails.waiter);
    expect((await w.post(`/api/tables/${f.table1.id}/regenerate-qr`)).status).toBe(403);
  });

  test('"libertar mesa": o empregado termina a sessão da mesa e o próximo grupo começa sem histórico', async () => {
    const f = await seedFullRestaurant(t, 'Liberta', 'lb');
    const w = await t.login(f.emails.waiter);
    const k = await t.login(f.emails.kitchen);
    const c = t.anon('203.0.113.32');
    await c.post(`/api/public/menu/${f.table1.token}/orders`, orderBody(f.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect((await c.get(`/api/public/menu/${f.table1.token}/orders`)).body.orders).toHaveLength(1);
    expect((await k.post(`/api/tables/${f.table1.id}/close-session`)).status).toBe(403);
    const r = await w.post(`/api/tables/${f.table1.id}/close-session`);
    expect(r.status).toBe(200);
    expect(r.body.closed).toBe(true);
    expect((await c.get(`/api/public/menu/${f.table1.token}/orders`)).body.orders).toHaveLength(0);
    expect((await w.post(`/api/tables/${f.table1.id}/close-session`)).body.closed).toBe(false); // já estava livre
    // novo pedido abre nova sessão
    await c.post(`/api/public/menu/${f.table1.token}/orders`, orderBody(f.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect((await c.get(`/api/public/menu/${f.table1.token}/orders`)).body.orders).toHaveLength(1);
    // mesa de outro restaurante
    expect((await w.post(`/api/tables/${A.table1.id}/close-session`)).status).toBe(404);
  });

  test('a sessão da mesa expira por inatividade', async () => {
    const t2 = await startTestApp({ env: { TABLE_SESSION_MINUTES: '10' } });
    try {
      const f = await seedFullRestaurant(t2, 'Expira', 'ex');
      const c = t2.anon('203.0.113.33');
      await c.post(`/api/public/menu/${f.table1.token}/orders`, orderBody(f.menu), { headers: { 'idempotency-key': uniqueKey() } });
      expect((await c.get(`/api/public/menu/${f.table1.token}/orders`)).body.orders).toHaveLength(1);
      await t2.db.system((tx) => tx`UPDATE table_sessions SET last_activity_at = now() - interval '11 minutes'`);
      expect((await c.get(`/api/public/menu/${f.table1.token}/orders`)).body.orders).toHaveLength(0);
      await c.post(`/api/public/menu/${f.table1.token}/orders`, orderBody(f.menu), { headers: { 'idempotency-key': uniqueKey() } });
      const sessions = await t2.db.system((tx) => tx<{ closed: boolean }>`SELECT closed_at IS NOT NULL AS closed FROM table_sessions ORDER BY opened_at`);
      expect(sessions.map((s) => s.closed)).toEqual([true, false]);
    } finally {
      await t2.close();
    }
  });

  test('desativar uma mesa bloqueia o QR; contadores de pedidos em curso; apagar mesas', async () => {
    const f = await seedFullRestaurant(t, 'Mesas', 'ms');
    const m = await t.login(f.emails.manager);
    const k = await t.login(f.emails.kitchen);
    const c = t.anon('203.0.113.34');
    await c.post(`/api/public/menu/${f.table1.token}/orders`, orderBody(f.menu), { headers: { 'idempotency-key': uniqueKey() } });
    await c.post(`/api/public/menu/${f.table1.token}/orders`, orderBody(f.menu), { headers: { 'idempotency-key': uniqueKey() } });
    const id1 = (await k.get('/api/orders')).body.orders[0].id;
    await k.post(`/api/order-status/${id1}`, { to: 'em_preparacao' });
    await k.post(`/api/order-status/${id1}`, { to: 'pronto' });
    const tables = (await m.get('/api/tables')).body.tables;
    expect(tables.find((x: any) => x.table_number === 1)).toMatchObject({ active_orders: 2, ready_orders: 1 });
    expect(tables.find((x: any) => x.table_number === 2)).toMatchObject({ active_orders: 0, ready_orders: 0 });

    const off = await m.patch(`/api/tables/${f.table1.id}`, { active: false, label: null });
    expect(off.body.table.active).toBe(false);
    expect(off.body.table.label).toBeNull();
    expect((await c.get(`/api/public/menu/${f.table1.token}`)).status).toBe(403);
    expect((await m.patch(`/api/tables/${f.table1.id}`, {})).status).toBe(400);
    expect((await m.patch(`/api/tables/${f.table1.id}`, { table_number: 9 })).status).toBe(400); // o número não se altera
    expect((await m.patch(`/api/tables/${f.table1.id}`, { active: true })).body.table.active).toBe(true);
    // apagar: com pedidos não; sem pedidos sim
    const del1 = await m.delete(`/api/tables/${f.table1.id}`);
    expect(del1.status).toBe(409);
    expect(del1.body.error.code).toBe('TABLE_HAS_ORDERS');
    expect((await m.delete(`/api/tables/${f.table2.id}`)).status).toBe(204);
    expect((await c.get(`/api/public/menu/${f.table2.token}`)).status).toBe(404);
    expect((await m.delete(`/api/tables/${f.table2.id}`)).status).toBe(404);
  });

  test('o gerente de B não consegue alterar, revogar ou apagar mesas de A', async () => {
    expect((await managerB.patch(`/api/tables/${A.table1.id}`, { active: false })).status).toBe(404);
    expect((await managerB.post(`/api/tables/${A.table1.id}/regenerate-qr`)).status).toBe(404);
    expect((await managerB.delete(`/api/tables/${A.table1.id}`)).status).toBe(404);
    expect((await customer.get(`/api/public/menu/${A.table1.token}`)).status).toBe(200);
  });
});

describe('definições do restaurante', () => {
  test('todos leem; só o gerente altera; valores inválidos são recusados', async () => {
    for (const c of [manager, kitchen, waiter]) {
      const r = await c.get('/api/restaurants/current');
      expect(r.status).toBe(200);
      expect(r.body.restaurant).toMatchObject({ name: 'Terraza A', timezone: 'Africa/Luanda', currency: 'AOA', service_fee_bps: 1000, accepting_orders: true, status: 'ativo' });
    }
    expect((await kitchen.patch('/api/restaurants/current', { name: 'Hack' })).status).toBe(403);
    const ok = await manager.patch('/api/restaurants/current', { name: 'Terraza Talatona', description: 'Terra & Mar', accent_color: '#B4541F', address: 'Talatona, Luanda', phone: '+244 900 000 000' });
    expect(ok.status).toBe(200);
    expect(ok.body.restaurant).toMatchObject({ name: 'Terraza Talatona', accent_color: '#B4541F', description: 'Terra & Mar' });
    const bad = (body: Record<string, unknown>) => manager.patch('/api/restaurants/current', body);
    expect((await bad({ service_fee_bps: 3001 })).status).toBe(400);
    expect((await bad({ service_fee_bps: -1 })).status).toBe(400);
    expect((await bad({ service_fee_bps: 10.5 })).status).toBe(400);
    expect((await bad({ accent_color: 'vermelho' })).status).toBe(400);
    expect((await bad({ name: 'X' })).status).toBe(400);
    expect((await bad({ logo_url: 'http://inseguro.ao/logo.png' })).status).toBe(400);
    expect((await bad({ status: 'suspenso' })).status).toBe(400); // só a plataforma
    expect((await bad({ menu_base_url: 'https://evil.pt' })).status).toBe(400);
    expect((await bad({ slug: 'novo-slug' })).status).toBe(400);
    const tz = await bad({ timezone: 'Marte/Olympus' });
    expect(tz.status).toBe(422);
    expect(tz.body.error.code).toBe('INVALID_TIMEZONE');
    expect((await bad({ timezone: 'Europe/Lisbon' })).body.restaurant.timezone).toBe('Europe/Lisbon');
    await bad({ timezone: 'Africa/Luanda' });
    // limpar a cor
    expect((await bad({ accent_color: '' })).body.restaurant.accent_color).toBeNull();
  });

  test('pausar pedidos por QR Code e a taxa de serviço aplicam-se de imediato a novos pedidos', async () => {
    await manager.patch('/api/restaurants/current', { service_fee_bps: 0 });
    const free = await customer.post(`/api/public/menu/${A.table2.token}/orders`, { items: [{ menu_item_id: A.menu.sumo.id, quantity: 1 }] }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(free.body.order.service_fee_cents).toBe(0);
    await manager.patch('/api/restaurants/current', { service_fee_bps: 1250 }); // 12,5 %
    const fee = await customer.post(`/api/public/menu/${A.table2.token}/orders`, { items: [{ menu_item_id: A.menu.sumo.id, quantity: 1 }] }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(fee.body.order.service_fee_cents).toBe(15000); // 12,5 % de 1 200 Kz = 150 Kz
    expect(fee.body.order.total_cents).toBe(135000);
    await manager.patch('/api/restaurants/current', { accepting_orders: false });
    expect((await customer.post(`/api/public/menu/${A.table2.token}/orders`, { items: [{ menu_item_id: A.menu.sumo.id, quantity: 1 }] }, { headers: { 'idempotency-key': uniqueKey() } })).status).toBe(409);
    await manager.patch('/api/restaurants/current', { accepting_orders: true });
    // pedido antigo mantém os valores
    expect((await customer.get(`/api/public/orders/${free.body.order.public_code}`)).body.order.service_fee_cents).toBe(0);
  });
});

describe('administração da plataforma', () => {
  let admin: Client;
  let created: any;

  beforeAll(async () => {
    admin = await t.login('admin@altiora.test');
  });

  test('criar restaurante com gerente: devolve a palavra-passe temporária UMA vez; o gerente tem de a trocar', async () => {
    const r = await admin.post('/api/admin/restaurants', { name: 'Terraço do Mar', manager: { name: 'Maria Gerente', email: 'Maria@Terraco.AO' } });
    expect(r.status).toBe(201);
    created = r.body;
    expect(created.restaurant.slug).toBe('terraco-do-mar');
    expect(created.restaurant.status).toBe('ativo');
    expect(created.manager.email).toBe('maria@terraco.ao');
    expect(created.manager.existing_account).toBe(false);
    const temp = created.manager.temporary_password as string;
    expect(temp).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);

    // a palavra-passe temporária não fica guardada em lado nenhum (nem na auditoria)
    const audits = await t.db.system((tx) => tx<{ m: string }>`SELECT metadata::text AS m FROM audit_logs`);
    expect(audits.some((a) => a.m.includes(temp))).toBe(false);
    const hashes = await t.db.system((tx) => tx<{ h: string }>`SELECT password_hash AS h FROM users WHERE email = 'maria@terraco.ao'`);
    expect(hashes[0]!.h.startsWith('scrypt$')).toBe(true);

    const mc = new Client(t.app);
    expect((await mc.post('/api/auth/login', { email: 'maria@terraco.ao', password: temp })).body.user.must_change_password).toBe(true);
    expect((await mc.get('/api/menu')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await mc.post('/api/auth/change-password', { current_password: temp, new_password: 'Gerente-Forte-2026' })).status).toBe(204);
    expect((await mc.get('/api/menu')).status).toBe(200);
    expect((await mc.post('/api/tables', { table_number: 1 })).status).toBe(201);
  });

  test('endereços (slug) repetidos geram sufixo; um slug manual repetido é recusado; e-mails existentes são associados', async () => {
    const again = await admin.post('/api/admin/restaurants', { name: 'Terraço do Mar', manager: { name: 'Outro', email: 'outro@terraco.ao' } });
    expect(again.status).toBe(201);
    expect(again.body.restaurant.slug).toBe('terraco-do-mar-2');
    const manual = await admin.post('/api/admin/restaurants', { name: 'Qualquer', slug: 'terraco-do-mar', manager: { name: 'X', email: 'x@terraco.ao' } });
    expect(manual.status).toBe(409);
    expect(manual.body.error.code).toBe('SLUG_TAKEN');
    // o restaurante recusado não ficou criado, nem o utilizador
    expect(await t.db.system(async (tx) => (await tx<{ n: number }>`SELECT count(*)::int AS n FROM users WHERE email = 'x@terraco.ao'`)[0]!.n)).toBe(0);
    // mesmo gerente para um segundo restaurante: associa à conta existente, sem nova palavra-passe
    const shared = await admin.post('/api/admin/restaurants', { name: 'Segundo Espaço', manager: { name: 'Maria Gerente', email: 'maria@terraco.ao' } });
    expect(shared.status).toBe(201);
    expect(shared.body.manager.existing_account).toBe(true);
    expect(shared.body.manager.temporary_password).toBeNull();
    const mc = await t.login('maria@terraco.ao', 'Gerente-Forte-2026');
    expect((await mc.get('/api/auth/me')).body.user.memberships).toHaveLength(2);
    // um e-mail de administrador da plataforma não pode ser gerente
    const bad = await admin.post('/api/admin/restaurants', { name: 'Impossível', manager: { name: 'Admin', email: 'admin@altiora.test' } });
    expect(bad.status).toBe(409);
    expect((await admin.post('/api/admin/restaurants', { name: 'X', manager: { name: 'Y', email: 'z@z.pt' } })).status).toBe(400); // nome curto
    expect((await admin.post('/api/admin/restaurants', { name: 'Valido', manager: { name: 'Y', email: 'invalido' } })).status).toBe(400);
  });

  test('listar restaurantes: só dados de contacto do gerente, sem pedidos nem valores', async () => {
    const r = await admin.get('/api/admin/restaurants');
    expect(r.status).toBe(200);
    const mar = r.body.restaurants.find((x: any) => x.slug === 'terraco-do-mar');
    expect(mar.managers).toEqual([{ id: expect.any(String), name: 'Maria Gerente', email: 'maria@terraco.ao' }]);
    expect(Object.keys(mar).sort()).toEqual(['created_at', 'currency', 'id', 'is_demo', 'managers', 'menu_base_url', 'name', 'plan_code', 'slug', 'status', 'subscription_notes', 'subscription_status', 'valid_until']);
    expect(JSON.stringify(r.body)).not.toContain('password');
  });

  test('suspender bloqueia a equipa e o menu público; reativar repõe tudo', async () => {
    const id = created.restaurant.id;
    const mc = await t.login('maria@terraco.ao', 'Gerente-Forte-2026');
    // o gerente liga-se ao primeiro restaurante ativo por nome; garantir que trabalha em "Terraço do Mar"
    await mc.post('/api/auth/switch-restaurant', { restaurant_id: id });
    const table = (await mc.post('/api/tables', { table_number: 2 })).body.table;
    const token = table.qr_url.split('/').pop();
    expect((await t.anon().get(`/api/public/menu/${token}`)).status).toBe(200);

    const sus = await admin.patch(`/api/admin/restaurants/${id}`, { status: 'suspenso' });
    expect(sus.status).toBe(200);
    expect(sus.body.restaurant.status).toBe('suspenso');
    expect((await mc.get('/api/tables')).body.error.code).toBe('RESTAURANT_SUSPENDED');
    expect((await t.anon().get(`/api/public/menu/${token}`)).body.error.code).toBe('RESTAURANT_UNAVAILABLE');

    expect((await admin.patch(`/api/admin/restaurants/${id}`, { status: 'ativo' })).status).toBe(200);
    expect((await mc.get('/api/tables')).status).toBe(200);
    expect((await t.anon().get(`/api/public/menu/${token}`)).status).toBe(200);
    expect((await admin.patch(`/api/admin/restaurants/${id}`, { status: 'inventado' })).status).toBe(400);
    expect((await admin.patch(`/api/admin/restaurants/${id}`, {})).status).toBe(400);
    expect((await admin.patch('/api/admin/restaurants/00000000-0000-4000-8000-000000000000', { status: 'ativo' })).status).toBe(404);
  });

  test('repor a palavra-passe de um gerente termina as suas sessões e obriga a trocá-la', async () => {
    const id = created.restaurant.id;
    const list = (await admin.get('/api/admin/restaurants')).body.restaurants.find((x: any) => x.id === id);
    const userId = list.managers[0].id;
    const mc = await t.login('maria@terraco.ao', 'Gerente-Forte-2026');
    const r = await admin.post(`/api/admin/restaurants/${id}/managers/${userId}/reset-password`);
    expect(r.status).toBe(200);
    expect(r.body.manager.temporary_password).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
    expect((await mc.get('/api/auth/me')).status).toBe(401);
    expect((await t.anon().post('/api/auth/login', { email: 'maria@terraco.ao', password: 'Gerente-Forte-2026' })).status).toBe(401);
    const again = await t.login('maria@terraco.ao', r.body.manager.temporary_password);
    expect((await again.get('/api/auth/me')).body.user.must_change_password).toBe(true);
    // não funciona com um utilizador que não é gerente desse restaurante
    expect((await admin.post(`/api/admin/restaurants/${id}/managers/${A.userIds.kitchen}/reset-password`)).status).toBe(404);
  });

  test('o registo da plataforma lista só ações "platform.*"; restaurantes não têm acesso à administração', async () => {
    const r = await admin.get('/api/admin/audit');
    expect(r.status).toBe(200);
    expect(r.body.entries.length).toBeGreaterThan(3);
    expect(r.body.entries.every((e: any) => e.action.startsWith('platform.'))).toBe(true);
    expect(r.body.entries.map((e: any) => e.action)).toContain('platform.restaurant.create');
    expect(JSON.stringify(r.body)).not.toMatch(/[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}/);
    for (const c of [manager, kitchen, waiter]) {
      expect((await c.get('/api/admin/restaurants')).status).toBe(403);
      expect((await c.post('/api/admin/restaurants', { name: 'Hack', manager: { name: 'a', email: 'a@a.pt' } })).status).toBe(403);
    }
    expect((await customer.get('/api/admin/restaurants')).status).toBe(401);
  });
});

