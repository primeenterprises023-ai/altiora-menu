// ALTIORA MENU: planos (o servidor recusa o que o plano não inclui), ficheiros enviados, «Chamar o garçom»,
// tamanhos dos pratos, formulário comercial e painel da Altiora (planos, assinaturas, utilização).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearFeatureCache } from '../src/lib/plans';
import { orderBody, seedFullRestaurant, seedPlatformAdmin, seedRestaurant, seedTable, startTestApp, uniqueKey, type Client, type TestApp } from './helpers';

// --- ficheiros de exemplo (pequenos, mas com cabeçalhos verdadeiros) ----------------------------------
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

/** JPEG com cabeçalho válido (64×32); `padTo` enche até esse tamanho. */
function jpeg(padTo = 200): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const out = new Uint8Array(Math.max(padTo, head.length));
  out.set(head);
  return out;
}

function glb(doc: Record<string, unknown> = { asset: { version: '2.0' }, meshes: [{ primitives: [] }] }): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const padded = new Uint8Array(json.length + ((4 - (json.length % 4)) % 4)).fill(0x20);
  padded.set(json);
  const out = new Uint8Array(20 + padded.length);
  const dv = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46]); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, padded.length, true);
  out.set([0x4a, 0x53, 0x4f, 0x4e], 16); // "JSON"
  out.set(padded, 20);
  return out;
}

const upload = (c: Client, bytes: Uint8Array) => c.request('POST', '/api/assets', { body: bytes as unknown as string, headers: { 'content-type': 'application/octet-stream' } });

let t: TestApp;
let P: Awaited<ReturnType<typeof seedFullRestaurant>>; // plano premium
let S: Awaited<ReturnType<typeof seedFullRestaurant>>; // começa em starter
let admin: Client;
let pm: Client; // gerente premium
let sm: Client; // gerente starter
let pw: Client; // empregado premium
let pk: Client;

const setPlan = async (restaurantId: string, plan: string) => {
  await t.db.system((tx) => tx`UPDATE subscriptions SET plan_code = ${plan} WHERE restaurant_id = ${restaurantId}`);
  clearFeatureCache();
};

beforeAll(async () => {
  t = await startTestApp();
  P = await seedFullRestaurant(t, 'Casa Premium', 'p');
  S = await seedFullRestaurant(t, 'Casa Starter', 's');
  await setPlan(S.restaurantId, 'starter');
  await seedPlatformAdmin(t);
  admin = await t.login('admin@altiora.test');
  pm = await t.login(P.emails.manager);
  pw = await t.login(P.emails.waiter);
  pk = await t.login(P.emails.kitchen);
  sm = await t.login(S.emails.manager);
});
afterAll(() => t.close());

describe('planos: o servidor recusa o que o plano não inclui', () => {
  test('o menu público do plano Starter não traz pedidos, WhatsApp, 3D nem chamada ao garçom (mesmo que os dados existam)', async () => {
    await t.db.system(async (tx) => {
      await tx`UPDATE restaurants SET whatsapp = '244923000000', accent_color = '#112233', theme = 'light', font = 'sans' WHERE id = ${S.restaurantId}`;
      await tx`UPDATE menu_items SET model_url = '/a/00000000-0000-4000-8000-000000000001' WHERE id = ${S.menu.moamba.id}`;
    });
    const r = await t.anon().get(`/api/public/menu/${S.table1.token}`);
    expect(r.status).toBe(200);
    expect(r.body.capabilities).toEqual({ orders: false, whatsapp: false, model_3d: false, ar: false, waiter_call: false });
    expect(r.body.restaurant).toMatchObject({ whatsapp: null, accent_color: null, theme: 'dark', font: 'serif', show_brand: true }); // sem personalização: tema escuro e letra da marca
    const items = r.body.categories.flatMap((c: any) => c.items);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.model_url).toBeNull();
  });

  test('no plano Premium tudo aparece (o WhatsApp só com número configurado)', async () => {
    const r = await t.anon().get(`/api/public/menu/${P.table1.token}`);
    expect(r.body.capabilities).toEqual({ orders: true, whatsapp: false, model_3d: true, ar: true, waiter_call: true });
    expect(r.body.restaurant.show_brand).toBe(false);
    const ok = await pm.patch('/api/restaurants/current', { whatsapp: '244 923 000 111', accent_color: '#B4541F', theme: 'light', font: 'serif' });
    expect(ok.status).toBe(200);
    expect(ok.body.restaurant).toMatchObject({ whatsapp: '244923000111', theme: 'light', font: 'serif' });
    const again = await t.anon().get(`/api/public/menu/${P.table1.token}`);
    expect(again.body.capabilities.whatsapp).toBe(true);
    expect(again.body.restaurant).toMatchObject({ whatsapp: '244923000111', theme: 'light' });
  });

  test('Starter: pedido do cliente, pedido manual, estatísticas, WhatsApp, cor, tema, letra, modelo 3D e chamada ao garçom → 403', async () => {
    const c = t.anon('203.0.113.10');
    const order = await c.post(`/api/public/menu/${S.table1.token}/orders`, orderBody(S.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect([order.status, order.body.error.code]).toEqual([403, 'PLAN_FEATURE']);
    expect((await c.post(`/api/public/menu/${S.table1.token}/call-waiter`)).status).toBe(403);

    const sw = await t.login(S.emails.waiter);
    const manual = await sw.post('/api/orders', { table_id: S.table1.id, items: [{ menu_item_id: S.menu.sumo.id, quantity: 1 }] });
    expect([manual.status, manual.body.error.code]).toEqual([403, 'PLAN_FEATURE']);

    const stats = await sm.get('/api/reports/sales?from=2026-01-01&to=2026-12-31');
    expect([stats.status, stats.body.error?.code]).toEqual([403, 'PLAN_FEATURE']);

    for (const patch of [{ whatsapp: '244923000000' }, { accent_color: '#B4541F' }, { theme: 'light' }, { font: 'serif' }]) {
      const r = await sm.patch('/api/restaurants/current', patch);
      expect({ patch, status: r.status, code: r.body.error?.code }).toEqual({ patch, status: 403, code: 'PLAN_FEATURE' });
    }
    const model = await upload(sm, glb());
    expect([model.status, model.body.error.code]).toEqual([403, 'PLAN_FEATURE']);
    // o essencial continua a funcionar no Starter
    expect((await sm.patch('/api/restaurants/current', { description: 'Cozinha angolana' })).status).toBe(200);
    expect((await upload(sm, PNG)).status).toBe(201);
  });

  test('quando a Altiora muda o plano, o efeito é imediato (Pro: pedidos sim, 3D não; Premium: tudo)', async () => {
    const sub = (body: Record<string, unknown>) => admin.patch(`/api/admin/restaurants/${S.restaurantId}/subscription`, body);
    expect((await sub({ plan_code: 'pro' })).status).toBe(200);
    const c = t.anon('203.0.113.11');
    const order = await c.post(`/api/public/menu/${S.table1.token}/orders`, orderBody(S.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect(order.status).toBe(201);
    expect((await upload(sm, glb())).status).toBe(403); // 3D só no Premium
    expect((await sm.get('/api/reports/sales?from=2026-01-01&to=2026-12-31')).status).toBe(200);
    expect((await sub({ plan_code: 'premium' })).status).toBe(200);
    expect((await upload(sm, glb())).status).toBe(201);
    expect((await sub({ plan_code: 'nao_existe' })).status).toBe(422);
    expect((await sub({ status: 'em_atraso', valid_until: '2026-12-31', notes: 'Renovação pendente' })).body.subscription).toMatchObject({ plan_code: 'premium', status: 'em_atraso', valid_until: '2026-12-31' });
    expect((await sub({ valid_until: '31/12/2026' })).status).toBe(400);
    await setPlan(S.restaurantId, 'starter');
  });

  test('o gerente vê o seu plano e o espaço usado; só o gerente', async () => {
    const r = await pm.get('/api/restaurants/current/plan');
    expect(r.status).toBe(200);
    expect(r.body.plan.plan.code).toBe('premium');
    expect(r.body.plan.features).toContain('model_3d');
    expect(r.body.plan.storage.quota_bytes).toBe(80 * 1024 * 1024);
    expect((await pw.get('/api/restaurants/current/plan')).status).toBe(403);
    // cozinha e empregados leem o perfil do restaurante
    for (const c of [pw, pk]) expect((await c.get('/api/restaurants/current')).status).toBe(200);
  });
});

describe('ficheiros enviados (fotografias e modelos 3D)', () => {
  test('fotografia PNG e JPEG: aceites, entregues em /a/<id> com cache longa, ETag e proteção do navegador', async () => {
    const png = await upload(pm, PNG);
    expect(png.status).toBe(201);
    expect(png.body.asset).toMatchObject({ kind: 'image', content_type: 'image/png', width: 1, height: 1 });
    expect(png.body.asset.url).toMatch(/^\/a\/[0-9a-f-]{36}$/);

    const jpg = await upload(pm, jpeg());
    expect(jpg.body.asset).toMatchObject({ content_type: 'image/jpeg', width: 64, height: 32 });

    const anon = t.anon('203.0.113.20');
    const got = await anon.get(png.body.asset.url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    const etag = got.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const cached = await anon.get(png.body.asset.url, { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    expect((await anon.get('/a/00000000-0000-4000-8000-000000000099')).status).toBe(404);
    expect((await anon.get('/a/nao-e-um-id')).status).toBe(404);
  });

  test('o conteúdo é conferido pelo que o ficheiro é: texto, HTML, SVG, ficheiro vazio e fotografia grande demais são recusados', async () => {
    for (const [name, bytes] of [
      ['texto', new TextEncoder().encode('olá')],
      ['html', new TextEncoder().encode('<html><script>alert(1)</script></html>')],
      ['svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ] as const) {
      const r = await upload(pm, bytes);
      expect({ name, status: r.status, code: r.body.error.code }).toEqual({ name, status: 422, code: 'ASSET_INVALID' });
    }
    expect((await upload(pm, new Uint8Array(0))).status).toBe(400);
    const big = await upload(pm, jpeg(2 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
  });

  test('modelos 3D (GLB): só sem ficheiros externos nem compressão que o visualizador não conhece', async () => {
    const ok = await upload(pm, glb());
    expect(ok.status).toBe(201);
    expect(ok.body.asset).toMatchObject({ kind: 'model', content_type: 'model/gltf-binary' });
    const served = await t.anon('203.0.113.21').get(ok.body.asset.url);
    expect(served.headers.get('content-type')).toBe('model/gltf-binary');

    const external = await upload(pm, glb({ asset: { version: '2.0' }, meshes: [{ primitives: [] }], buffers: [{ uri: 'https://exemplo.com/x.bin', byteLength: 4 }] }));
    expect([external.status, external.body.error.code]).toEqual([422, 'ASSET_INVALID']);
    const draco = await upload(pm, glb({ asset: { version: '2.0' }, meshes: [{ primitives: [] }], extensionsRequired: ['KHR_draco_mesh_compression'] }));
    expect([draco.status, draco.body.error.code]).toEqual([422, 'ASSET_INVALID']);
    const empty = await upload(pm, glb({ asset: { version: '2.0' } }));
    expect(empty.status).toBe(422);
    const truncated = glb().slice(0, 30);
    expect((await upload(pm, truncated)).status).toBe(422);
  });

  test('só o gerente envia ficheiros; cozinha, empregados e visitantes não', async () => {
    expect((await upload(pk, PNG)).status).toBe(403);
    expect((await upload(pw, PNG)).status).toBe(403);
    expect((await upload(t.anon('203.0.113.22'), PNG)).status).toBe(401);
  });

  test('prato com fotografia, miniatura e modelo: aparecem no menu público (3D só no plano Premium)', async () => {
    const [img, thumb, model] = [await upload(pm, jpeg()), await upload(pm, jpeg()), await upload(pm, glb())];
    const created = await pm.post('/api/menu/items', {
      category_id: P.menu.categoryId, name: 'Bitoque da casa', description: 'Bife com ovo e batata frita', price_cents: 520000,
      image_url: img.body.asset.url, thumb_url: thumb.body.asset.url, model_url: model.body.asset.url,
      ingredients: ['Bife', 'Ovo', 'Batata'], allergens: ['ovos', 'leite'],
    });
    expect(created.status).toBe(201);
    const menu = await t.anon('203.0.113.23').get(`/api/public/menu/${P.table1.token}`);
    const dish = menu.body.categories.flatMap((c: any) => c.items).find((i: any) => i.name === 'Bitoque da casa');
    expect(dish).toMatchObject({ image_url: img.body.asset.url, thumb_url: thumb.body.asset.url, model_url: model.body.asset.url, ingredients: ['Bife', 'Ovo', 'Batata'], allergens: ['ovos', 'leite'] });
    // endereços que não são do próprio site ou de um ficheiro enviado são recusados no modelo
    const bad = await pm.post('/api/menu/items', { category_id: P.menu.categoryId, name: 'X1', price_cents: 100, model_url: 'https://exemplo.com/x.glb' });
    expect(bad.status).toBe(400);
    const badAllergen = await pm.post('/api/menu/items', { category_id: P.menu.categoryId, name: 'X2', price_cents: 100, allergens: ['pimenta'] });
    expect(badAllergen.status).toBe(400);
  });

  test('ficheiros que já não são usados são apagados (depois de 15 minutos); os usados ficam', async () => {
    const used = (await upload(pm, jpeg())).body.asset;
    const unused = (await upload(pm, jpeg())).body.asset;
    const item = (await pm.post('/api/menu/items', { category_id: P.menu.categoryId, name: 'Com foto', price_cents: 1000, image_url: used.url })).body.item;
    await t.db.system((tx) => tx`UPDATE assets SET created_at = now() - interval '2 hours' WHERE id IN (${used.id}, ${unused.id})`);
    expect((await pm.patch(`/api/menu/items/${item.id}`, { description: 'Atualizado' })).status).toBe(200);
    expect((await t.anon('203.0.113.24').get(used.url)).status).toBe(200);
    expect((await t.anon('203.0.113.24').get(unused.url)).status).toBe(404);
  });

  test('o espaço de ficheiros de cada restaurante tem limite', async () => {
    const q = await startTestApp({ env: { ASSET_QUOTA_MB: '5' } });
    try {
      const f = await seedFullRestaurant(q, 'Pouco Espaço', 'q');
      const c = await q.login(f.emails.manager);
      const one = jpeg(1_900_000);
      expect((await upload(c, one)).status).toBe(201);
      expect((await upload(c, one)).status).toBe(201);
      const third = await upload(c, one);
      expect([third.status, third.body.error.code]).toEqual([413, 'STORAGE_FULL']);
      // outro restaurante tem o seu próprio espaço
      const g = await seedFullRestaurant(q, 'Outro', 'r');
      expect((await upload(await q.login(g.emails.manager), one)).status).toBe(201);
    } finally {
      await q.close();
    }
  });
});

describe('«Chamar o garçom»', () => {
  const call = (c: Client, token: string) => c.post(`/api/public/menu/${token}/call-waiter`);

  test('o cliente chama, o empregado vê a mesa e atende; uma chamada aberta por mesa', async () => {
    const events: Array<{ rid: string; type: string }> = [];
    const original = t.deps.hub.publishRestaurant.bind(t.deps.hub);
    t.deps.hub.publishRestaurant = (rid, ev) => {
      events.push({ rid, type: (ev as { type: string }).type });
      return original(rid, ev);
    };
    try {
      const c = t.anon('203.0.113.30');
      const first = await call(c, P.table2.token);
      expect(first.status).toBe(201);
      const second = await call(c, P.table2.token); // duplo toque: a mesma chamada
      expect(second.status).toBe(200);
      expect(second.body.call.id).toBe(first.body.call.id);
      expect(events.filter((e) => e.type === 'waiter.call')).toEqual([{ rid: P.restaurantId, type: 'waiter.call' }]); // avisou uma só vez

      const menu = await c.get(`/api/public/menu/${P.table2.token}`);
      expect(menu.body.waiter_call).toMatchObject({ id: first.body.call.id });

      const list = await pw.get('/api/staff/waiter-calls');
      expect(list.status).toBe(200);
      expect(list.body.calls).toHaveLength(1);
      expect(Number.isNaN(Date.parse(list.body.server_time))).toBe(false);
      expect(list.body.calls[0]).toMatchObject({ id: first.body.call.id, table_number: 2, table_label: 'Esplanada', status: 'aberta' });

      expect((await pk.get('/api/staff/waiter-calls')).status).toBe(403); // a cozinha não trata de mesas
      expect((await (await t.login(S.emails.waiter)).get('/api/staff/waiter-calls')).body.calls).toEqual([]); // outro restaurante não vê

      const done = await pw.post(`/api/staff/waiter-calls/${first.body.call.id}/attend`);
      expect(done.status).toBe(200);
      expect(done.body.call.status).toBe('atendida');
      expect(events.some((e) => e.type === 'waiter.call.done')).toBe(true);
      expect((await pw.post(`/api/staff/waiter-calls/${first.body.call.id}/attend`)).status).toBe(409);
      expect((await pw.post('/api/staff/waiter-calls/00000000-0000-4000-8000-000000000001/attend')).status).toBe(404);
      expect((await c.get(`/api/public/menu/${P.table2.token}`)).body.waiter_call).toBeNull();
      expect((await call(c, P.table2.token)).status).toBe(201); // pode chamar de novo
    } finally {
      t.deps.hub.publishRestaurant = original;
    }
  });

  test('o cliente pode desistir; mesa desconhecida → 404; o empregado de outro restaurante não atende', async () => {
    const c = t.anon('203.0.113.31');
    const made = await call(c, P.table1.token);
    expect(made.status).toBe(201);
    const other = await (await t.login(S.emails.waiter)).post(`/api/staff/waiter-calls/${made.body.call.id}/attend`);
    expect(other.status).toBe(404);
    const cancelled = await c.post(`/api/public/menu/${P.table1.token}/call-waiter/cancel`);
    expect(cancelled.body).toEqual({ cancelled: 1 });
    expect((await c.post(`/api/public/menu/${P.table1.token}/call-waiter/cancel`)).body).toEqual({ cancelled: 0 });
    expect((await pw.get('/api/staff/waiter-calls')).body.calls.some((x: any) => x.id === made.body.call.id)).toBe(false);
    expect((await call(c, 'token-que-nao-existe-123')).status).toBe(404);
  });

  test('o cardápio de demonstração não chama ninguém', async () => {
    const id = await seedRestaurant(t, 'Demo Teste', { slug: 'demo-teste' });
    await t.db.system((tx) => tx`UPDATE restaurants SET is_demo = true WHERE id = ${id}`);
    const table = await seedTable(t, id, 1);
    expect((await call(t.anon('203.0.113.32'), table.token)).status).toBe(403);
  });
});

describe('tamanhos dos pratos', () => {
  let pizza: { id: string };
  let small: string;
  let large: string;
  let cheese: string;
  beforeAll(async () => {
    pizza = (await pm.post('/api/menu/items', { category_id: P.menu.categoryId, name: 'Pizza margherita', price_cents: 400000 })).body.item;
    small = (await pm.post(`/api/menu/items/${pizza.id}/options`, { name: 'Pequena', kind: 'size', price_delta_cents: 0 })).body.option.id;
    large = (await pm.post(`/api/menu/items/${pizza.id}/options`, { name: 'Grande', kind: 'size', price_delta_cents: 200000 })).body.option.id;
    cheese = (await pm.post(`/api/menu/items/${pizza.id}/options`, { name: 'Queijo extra', price_delta_cents: 50000 })).body.option.id;
  });
  const order = (items: unknown[]) => t.anon('203.0.113.40').post(`/api/public/menu/${P.table1.token}/orders`, { items }, { headers: { 'idempotency-key': uniqueKey() } });

  test('o menu público separa tamanhos e extras', async () => {
    const menu = await t.anon('203.0.113.41').get(`/api/public/menu/${P.table1.token}`);
    const dish = menu.body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === pizza.id);
    expect(dish.options.map((o: any) => [o.name, o.kind]).sort()).toEqual([['Grande', 'size'], ['Pequena', 'size'], ['Queijo extra', 'extra']]);
  });

  test('sem tamanho, com dois tamanhos ou com tamanho em quantidade errada → recusado', async () => {
    const none = await order([{ menu_item_id: pizza.id, quantity: 1 }]);
    expect([none.status, none.body.error.code]).toEqual([422, 'SIZE_REQUIRED']);
    const two = await order([{ menu_item_id: pizza.id, quantity: 1, options: [{ option_id: small }, { option_id: large }] }]);
    expect([two.status, two.body.error.code]).toEqual([422, 'SIZE_REQUIRED']);
    const many = await order([{ menu_item_id: pizza.id, quantity: 1, options: [{ option_id: large, quantity: 2 }] }]);
    expect([many.status, many.body.error.code]).toEqual([422, 'SIZE_ONE']);
    const other = await order([{ menu_item_id: P.menu.sumo.id, quantity: 1, options: [{ option_id: large }] }]);
    expect([other.status, other.body.error.code]).toEqual([422, 'OPTION_NOT_FOUND']);
  });

  test('com tamanho: o servidor soma o preço do tamanho e dos extras', async () => {
    const r = await order([{ menu_item_id: pizza.id, quantity: 2, options: [{ option_id: large }, { option_id: cheese }] }]);
    expect(r.status).toBe(201);
    // (4000 + 2000 + 500) Kz × 2 = 13 000 Kz = 1 300 000 cêntimos (+ taxa de serviço do restaurante, que é 0 aqui)
    expect(r.body.order.subtotal_cents).toBe(1_300_000);
    expect(r.body.order.items[0].options.map((o: any) => o.name).sort()).toEqual(['Grande', 'Queijo extra']);
  });
});

describe('perfil do restaurante (gerente)', () => {
  test('horário, contactos e aparência: guarda-se e volta tal como foi escrito', async () => {
    const hours = { mon: [['08:00', '22:00']], sun: [['12:00', '15:00'], ['19:00', '02:00']] };
    const r = await pm.patch('/api/restaurants/current', { opening_hours: hours, email: 'Geral@Casa-Premium.test', whatsapp: '+244 923 111 222', maps_url: 'https://maps.example/casa', theme: 'light', font: 'sans', accent_color: '#aa5500' });
    expect(r.status).toBe(200);
    expect(r.body.restaurant).toMatchObject({ email: 'geral@casa-premium.test', whatsapp: '244923111222', maps_url: 'https://maps.example/casa', theme: 'light', font: 'sans', accent_color: '#aa5500' });
    expect(r.body.restaurant.opening_hours).toEqual(hours); // um objeto, não texto
    const again = await pm.get('/api/restaurants/current');
    expect(again.body.restaurant.opening_hours).toEqual(hours);
    const pub = await t.anon().get(`/api/public/menu/${P.table1.token}`);
    expect(pub.body.restaurant.opening_hours).toEqual(hours);
    expect(pub.body.restaurant).toMatchObject({ theme: 'light', font: 'sans', whatsapp: '244923111222' });
  });

  test('um horário vazio apaga o horário; horários inválidos são recusados', async () => {
    expect((await pm.patch('/api/restaurants/current', { opening_hours: {} })).body.restaurant.opening_hours).toEqual({});
    for (const bad of [
      { mon: [['25:00', '22:00']] },
      { mon: [['10:00', '10:00']] },
      { mon: [['08:00', '09:00'], ['10:00', '11:00'], ['12:00', '13:00'], ['14:00', '15:00']] },
      { xyz: [['08:00', '09:00']] },
      { mon: 'sempre aberto' },
    ]) {
      const r = await pm.patch('/api/restaurants/current', { opening_hours: bad });
      // se falhar, a mensagem mostra o horário que foi aceite por engano
      expect([JSON.stringify(bad), r.status >= 400 && r.status < 500]).toEqual([JSON.stringify(bad), true]);
    }
    expect((await pm.get('/api/restaurants/current')).body.restaurant.opening_hours).toEqual({});
  });

  test('contactos inválidos são recusados', async () => {
    for (const bad of [{ email: 'sem-arroba' }, { whatsapp: '123' }, { maps_url: 'http://inseguro.test' }, { logo_url: 'javascript:alert(1)' }, { cover_url: '//outro-sitio.test/x.jpg' }]) {
      const r = await pm.patch('/api/restaurants/current', bad);
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
  });

  test('plano Starter: o horário e os contactos sim; cor, tema, letra e WhatsApp não', async () => {
    const ok = await sm.patch('/api/restaurants/current', { opening_hours: { fri: [['10:00', '23:00']] }, email: 'geral@starter.test', maps_url: 'https://maps.example/s' });
    expect(ok.status).toBe(200);
    expect(ok.body.restaurant.opening_hours).toEqual({ fri: [['10:00', '23:00']] });
    for (const body of [{ accent_color: '#112233' }, { theme: 'light' }, { font: 'sans' }, { whatsapp: '244923000000' }]) {
      const r = await sm.patch('/api/restaurants/current', body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 403]);
      expect(r.body.error.code).toBe('PLAN_FEATURE');
    }
  });
});

describe('gestão avançada: exportação CSV e registo de atividade', () => {
  const RANGE = 'from=2026-01-01&to=2026-12-31';
  afterAll(() => setPlan(S.restaurantId, 'starter'));

  test('Starter não tem relatórios nem CSV; Pro tem relatórios mas não o CSV (o servidor recusa, não só o botão)', async () => {
    await setPlan(S.restaurantId, 'starter');
    const a = await sm.get(`/api/reports/sales.csv?${RANGE}`);
    expect([a.status, a.body.error.code, a.body.error.details.feature]).toEqual([403, 'PLAN_FEATURE', 'stats']);
    await setPlan(S.restaurantId, 'pro');
    const b = await sm.get(`/api/reports/sales.csv?${RANGE}`);
    expect([b.status, b.body.error.code, b.body.error.details.feature]).toEqual([403, 'PLAN_FEATURE', 'advanced_management']);
    expect((await sm.get(`/api/reports/sales?${RANGE}`)).status).toBe(200);
    const log = await sm.get('/api/activity');
    expect([log.status, log.body.error.code, log.body.error.details.feature]).toEqual([403, 'PLAN_FEATURE', 'advanced_management']);
  });

  test('Premium: o CSV traz o relatório do período, com os cabeçalhos certos, e a exportação fica registada', async () => {
    const c = t.anon('203.0.113.40');
    const order = await c.post(`/api/public/menu/${P.table1.token}/orders`, orderBody(P.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect(order.status).toBe(201);

    const r = await pm.get('/api/reports/sales.csv');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="vendas-\d{4}-\d{2}-\d{2}_a_\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const csv = r.body as string;
    expect(csv.startsWith('﻿Dia;Pedidos (sem cancelados);Vendas registadas (Kz);Pagamentos confirmados (Kz)\r\n')).toBe(true);
    const total = csv.split('\r\n').find((l) => l.startsWith('Total;'))!;
    expect(Number(total.split(';')[1])).toBeGreaterThanOrEqual(1);
    expect(csv).toContain('Pratos mais vendidos;Quantidade;Total (Kz)');

    // o ficheiro e o relatório do ecrã dizem o mesmo
    const json = await pm.get('/api/reports/sales');
    expect(total.split(';')[1]).toBe(String(json.body.report.sales.orders));

    const log = await pm.get('/api/activity?limit=5');
    expect(log.body.entries.some((e: any) => /^Exportou o relatório de vendas em CSV \(\d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}\)\.$/.test(e.text))).toBe(true);
  });

  test('o CSV recusa períodos inválidos e perfis que não são de gerente', async () => {
    expect((await pm.get('/api/reports/sales.csv?from=2026-02-01&to=2026-01-01')).body.error.code).toBe('RANGE_INVALID');
    expect((await pm.get('/api/reports/sales.csv?from=ontem')).status).toBe(400);
    expect((await pm.get('/api/reports/sales.csv?from=2020-01-01&to=2026-12-31')).body.error.code).toBe('RANGE_TOO_LARGE');
    for (const c of [pw, pk]) {
      expect((await c.get('/api/reports/sales.csv')).status).toBe(403);
      expect((await c.get('/api/activity')).status).toBe(403);
    }
    expect((await t.anon().get('/api/reports/sales.csv')).status).toBe(401);
    expect((await t.anon().get('/api/activity')).status).toBe(401);
  });

  test('o registo de atividade mostra frases com o nome de quem agiu — sem IP, e-mails nem dados técnicos', async () => {
    const name = `Sobremesas ${uniqueKey().slice(0, 6)}`;
    expect((await pm.post('/api/menu/categories', { name })).status).toBe(201);
    const r = await pm.get('/api/activity');
    expect(r.status).toBe(200);
    const first = r.body.entries[0];
    expect(first.text).toBe(`Criou a categoria «${name}».`);
    expect(first.actor_name).toBe(P.emails.manager.split('@')[0]);
    expect(first.actor_role).toBe('manager');
    expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const raw = JSON.stringify(r.body);
    for (const leak of ['"ip"', pm.ip, P.emails.manager, 'metadata', 'password']) expect([leak, raw.includes(leak)]).toEqual([leak, false]);
    for (const e of r.body.entries) expect(e.text.startsWith('Ação registada')).toBe(false); // todos os códigos têm frase
  });

  test('paginação: «ver mais antigos» continua onde parou, sem repetir linhas', async () => {
    for (let i = 0; i < 3; i++) await pm.post('/api/menu/categories', { name: `Página ${i} ${uniqueKey().slice(0, 4)}` });
    const one = await pm.get('/api/activity?limit=2');
    expect(one.body.entries).toHaveLength(2);
    expect(one.body.next_before).toBe(one.body.entries[1].id);
    const two = await pm.get(`/api/activity?limit=2&before=${one.body.next_before}`);
    expect(two.body.entries).toHaveLength(2);
    const ids = [...one.body.entries, ...two.body.entries].map((e: any) => BigInt(e.id));
    expect(new Set(ids.map(String)).size).toBe(4);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! < ids[i - 1]!).toBe(true); // do mais recente para o mais antigo
    const end = await pm.get('/api/activity?limit=100&before=1');
    expect(end.body).toEqual({ entries: [], next_before: null });
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'before=abc', 'before=1;DROP', 'before=-5', 'extra=1']) {
      expect([bad, (await pm.get(`/api/activity?${bad}`)).status]).toEqual([bad, 400]);
    }
  });

  test('cada restaurante só vê a sua atividade; ações da plataforma e dos outros nunca aparecem', async () => {
    await setPlan(S.restaurantId, 'premium');
    const mine = `Só do Starter ${uniqueKey().slice(0, 6)}`;
    const theirs = `Só do Premium ${uniqueKey().slice(0, 6)}`;
    expect((await sm.post('/api/menu/categories', { name: mine })).status).toBe(201);
    expect((await pm.post('/api/menu/categories', { name: theirs })).status).toBe(201);
    // uma ação da Altiora sobre este restaurante (fica na auditoria da plataforma, não no registo do restaurante)
    expect((await admin.patch(`/api/admin/restaurants/${S.restaurantId}/subscription`, { notes: 'visto pela Altiora' })).status).toBe(200);

    const s = (await sm.get('/api/activity?limit=100')).body.entries.map((e: any) => e.text).join('\n');
    const p = (await pm.get('/api/activity?limit=100')).body.entries.map((e: any) => e.text).join('\n');
    expect(s).toContain(mine);
    expect(s).not.toContain(theirs);
    expect(p).toContain(theirs);
    expect(p).not.toContain(mine);
    expect(s).not.toContain('platform');
    expect(s).not.toContain('Altiora');
  });
});

describe('formulário da página comercial', () => {
  const lead = (c: Client, body: Record<string, unknown>) => c.post('/api/leads', body);
  const valid = { name: 'Rita Fernandes', business: 'Restaurante Mar Azul', phone: '+244 923 000 000', email: 'rita@marazul.ao', message: 'Queremos o plano Pro.', consent: true, website: '' };

  test('guarda o pedido e o painel da Altiora trata-o; ninguém mais o vê', async () => {
    const r = await lead(t.anon('203.0.113.50'), valid);
    expect(r.status).toBe(201);
    const list = await admin.get('/api/admin/leads');
    const mine = list.body.leads.find((l: any) => l.email === 'rita@marazul.ao');
    expect(mine).toMatchObject({ name: 'Rita Fernandes', business: 'Restaurante Mar Azul', status: 'novo' });
    expect((await admin.patch(`/api/admin/leads/${mine.id}`, { status: 'contactado' })).body.lead.status).toBe('contactado');
    expect((await admin.patch(`/api/admin/leads/${mine.id}`, { status: 'qualquer' })).status).toBe(400);
    expect((await pm.get('/api/admin/leads')).status).toBe(403);
    expect((await t.anon('203.0.113.50').get('/api/admin/leads')).status).toBe(401);
    expect((await admin.delete(`/api/admin/leads/${mine.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/admin/leads/${mine.id}`)).status).toBe(404);
  });

  test('sem consentimento, sem contacto, e-mail inválido, campos a mais ou texto enorme → 400', async () => {
    const c = t.anon('203.0.113.51');
    for (const [name, body] of [
      ['sem consentimento', { ...valid, consent: false }],
      ['consentimento em falta', { ...valid, consent: undefined }],
      ['sem contacto', { ...valid, phone: '', email: '' }],
      ['e-mail inválido', { ...valid, email: 'rita@' }],
      ['nome curto', { ...valid, name: 'R' }],
      ['campo desconhecido', { ...valid, role: 'admin' }],
      ['mensagem enorme', { ...valid, message: 'x'.repeat(1501) }],
    ] as const) {
      const r = await lead(c, body);
      expect({ name, status: r.status }).toEqual({ name, status: 400 });
    }
  });

  test('robôs que preenchem o campo escondido recebem "ok" mas nada é guardado', async () => {
    const before = (await admin.get('/api/admin/leads')).body.leads.length;
    const r = await lead(t.anon('203.0.113.52'), { ...valid, email: 'robo@spam.test', website: 'http://spam.test' });
    expect(r.status).toBe(201);
    expect((await admin.get('/api/admin/leads')).body.leads.length).toBe(before);
  });
});

describe('painel da Altiora: planos, assinaturas e utilização', () => {
  test('lista os planos com funcionalidades; só a plataforma os altera; o efeito nos restaurantes é imediato', async () => {
    const list = await admin.get('/api/admin/plans');
    expect(list.status).toBe(200);
    expect(list.body.plans.map((p: any) => p.code)).toEqual(['starter', 'pro', 'premium']);
    expect(list.body.plans[0].features).toEqual(['menu', 'qr_codes', 'basic_products']);
    expect((await pm.get('/api/admin/plans')).status).toBe(403);
    expect((await pm.patch('/api/admin/plans/starter', { features: ['model_3d'] })).status).toBe(403);

    // dar estatísticas ao Starter: o restaurante Starter passa a vê-las já
    expect((await sm.get('/api/reports/sales?from=2026-01-01&to=2026-12-31')).status).toBe(403);
    const patched = await admin.patch('/api/admin/plans/starter', { features: ['menu', 'qr_codes', 'basic_products', 'stats'] });
    expect(patched.status).toBe(200);
    expect((await sm.get('/api/reports/sales?from=2026-01-01&to=2026-12-31')).status).toBe(200);
    await admin.patch('/api/admin/plans/starter', { features: ['menu', 'qr_codes', 'basic_products'] });
    expect((await sm.get('/api/reports/sales?from=2026-01-01&to=2026-12-31')).status).toBe(403);

    expect((await admin.patch('/api/admin/plans/starter', { features: ['voar'] })).status).toBe(400);
    expect((await admin.patch('/api/admin/plans/nao_existe', { name: 'Xpto' })).status).toBe(404);
  });

  test('preços configuráveis por moeda; novos planos; um só plano em destaque', async () => {
    const priced = await admin.patch('/api/admin/plans/pro', {
      prices: [{ currency: 'AOA', monthly_cents: 4_500_000, yearly_cents: 45_000_000 }, { currency: 'USD', monthly_cents: 4900, yearly_cents: null }],
    });
    expect(priced.status).toBe(200);
    expect(priced.body.plan.prices).toEqual([
      { currency: 'AOA', monthly_cents: 4_500_000, yearly_cents: 45_000_000 },
      { currency: 'USD', monthly_cents: 4900, yearly_cents: null },
    ]);
    expect((await admin.patch('/api/admin/plans/pro', { prices: [{ currency: 'XYZ', monthly_cents: 1, yearly_cents: null }] })).status).toBe(400);
    expect((await admin.patch('/api/admin/plans/pro', { prices: [{ currency: 'AOA', monthly_cents: -5, yearly_cents: null }] })).status).toBe(400);

    const gold = await admin.post('/api/admin/plans', { code: 'gold', name: 'Gold', tagline: 'Para cadeias', display_order: 4, highlighted: false, active: true, features: ['menu', 'orders'], prices: [] });
    expect(gold.status).toBe(201);
    expect((await admin.post('/api/admin/plans', { code: 'gold', name: 'Gold', tagline: '', display_order: 4, highlighted: false, active: true, features: [], prices: [] })).status).toBe(409);
    expect((await admin.post('/api/admin/plans', { code: 'Ouro Fino', name: 'x', tagline: '', display_order: 1, highlighted: false, active: true, features: [], prices: [] })).status).toBe(400);

    await admin.patch('/api/admin/plans/premium', { highlighted: true });
    const after = (await admin.get('/api/admin/plans')).body.plans;
    expect(after.filter((p: any) => p.highlighted).map((p: any) => p.code)).toEqual(['premium']);
  });

  test('a lista de restaurantes mostra plano e estado; a utilização traz só contagens', async () => {
    expect((await admin.patch(`/api/admin/restaurants/${S.restaurantId}/subscription`, { notes: 'Contrato combinado por telefone' })).status).toBe(200);
    const list = await admin.get('/api/admin/restaurants');
    const s = list.body.restaurants.find((r: any) => r.id === S.restaurantId);
    expect(s).toMatchObject({ plan_code: 'starter', subscription_status: 'em_atraso', valid_until: '2026-12-31', subscription_notes: 'Contrato combinado por telefone', is_demo: false, currency: 'AOA' });
    // a nota interna é só da Altiora: o gerente do restaurante nunca a vê
    const mine = await sm.get('/api/restaurants/current/plan');
    expect(JSON.stringify(mine.body)).not.toContain('Contrato combinado');
    const usage = await admin.get('/api/admin/usage');
    expect(usage.status).toBe(200);
    const row = usage.body.usage.find((u: any) => u.restaurant_id === P.restaurantId);
    expect(Object.keys(row).sort()).toEqual(['assets_bytes', 'items_count', 'items_with_3d', 'last_order_at', 'orders_30d', 'restaurant_id', 'staff_count', 'tables_count']);
    expect(row.tables_count).toBe(2);
    expect(row.items_with_3d).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(usage.body)).not.toMatch(/total_cents|subtotal|price/);
    expect((await pm.get('/api/admin/usage')).status).toBe(403);
  });
});

describe('isolamento entre restaurantes (novas tabelas)', () => {
  test('a plataforma não lê ficheiros nem chamadas dos restaurantes; a cozinha e o empregado não leem ficheiros de outro restaurante', async () => {
    const probe = (role: 'platform' | 'public', table: string, restaurantId?: string) =>
      t.db.as({ role, restaurantId }, (tx) => tx.unsafe(`SELECT count(*)::int AS n FROM ${table}`)).then(
        (rows) => `lê ${(rows as Array<{ n: number }>)[0]!.n}`,
        () => 'negado',
      );
    expect(await probe('platform', 'assets')).toBe('negado');
    expect(await probe('platform', 'waiter_calls')).toBe('negado');
    expect(await probe('platform', 'leads')).toMatch(/^lê/); // os pedidos comerciais são da Altiora
    expect(await probe('public', 'leads')).toBe('negado');
    expect(await probe('public', 'assets')).toBe('negado'); // ficheiros só saem por /a/<id>
    expect(await probe('public', 'subscriptions')).toBe('negado');
  });

  test('as chamadas só são visíveis ao restaurante da mesa', async () => {
    const mine = await t.db.as({ role: 'waiter', restaurantId: S.restaurantId }, (tx) => tx`SELECT count(*)::int AS n FROM waiter_calls`);
    const other = await t.db.as({ role: 'waiter', restaurantId: P.restaurantId }, (tx) => tx`SELECT count(*)::int AS n FROM waiter_calls`);
    expect(mine[0]!.n).toBe(0);
    expect(other[0]!.n).toBeGreaterThan(0);
  });
});
