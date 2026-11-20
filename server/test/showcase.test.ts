// Restaurante-montra «Casa Aurora»: criado ao arrancar (SEED_SHOWCASE) ou pela linha de comandos, sem nunca apagar nem
// duplicar nada. Verifica o resultado de ponta a ponta: o que está na base de dados, o que o público vê e a página comercial.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { seedShowcase } from '../src/demo/showcase';
import { seedRestaurant, startTestApp, type TestApp } from './helpers';

const MEDIA = join(import.meta.dir, '../../scripts/demo-media/assets');

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ env: { DEMO_RESTAURANT_SLUG: 'montra', DEMO_MEDIA_DIR: MEDIA } });
});
afterAll(async () => {
  await t.close();
});

const rows = <T>(fn: (tx: Parameters<Parameters<typeof t.db.system>[0]>[0]) => Promise<T>) => t.db.system(fn);

describe('configuração', () => {
  test('SEED_SHOWCASE vem desligado por omissão e DEMO_MEDIA_DIR aponta para as imagens do projeto', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x@localhost/x' });
    expect(c.seedShowcase).toBe(false);
    expect(c.demoMediaDir).toBe('./scripts/demo-media/assets');
  });
  test('DATABASE_PREPARE vem ligado por omissão e pode ser desligado (transaction pooler)', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x@localhost/x' }).databasePrepare).toBe(true);
    expect(loadConfig({ DATABASE_URL: 'postgres://x@localhost/x', DATABASE_PREPARE: 'false' }).databasePrepare).toBe(false);
  });
  test('«true», «1» e «sim» ligam o restaurante-montra', () => {
    for (const v of ['true', '1', 'sim']) expect(loadConfig({ DATABASE_URL: 'postgres://x@localhost/x', SEED_SHOWCASE: v }).seedShowcase).toBe(true);
  });
});

describe('criar a Casa Aurora', () => {
  test('sem os ficheiros de demonstração, falha com uma frase clara e não deixa nada pela metade', async () => {
    await expect(seedShowcase(t.db, { demoSlug: 'montra', demoMediaDir: join(MEDIA, 'nao-existe') })).rejects.toThrow('DEMO_MEDIA_DIR');
    const [r] = await rows((tx) => tx<{ n: number }>`SELECT count(*)::int AS n FROM restaurants WHERE slug = 'montra'`);
    expect(r!.n).toBe(0);
  });

  test('cria o restaurante com 12 pratos, 7 deles com modelo 3D', async () => {
    const result = await seedShowcase(t.db, t.config);
    expect(result).toEqual({ created: true, slug: 'montra', dishes: 12, models: 7 });
  });

  test('é um restaurante de demonstração, no plano Premium, sem equipa nem mesas', async () => {
    const [r] = await rows((tx) => tx<{ id: string; name: string; is_demo: boolean; status: string; plan_code: string; members: number; tables: number }>`
      SELECT r.id, r.name, r.is_demo, r.status, s.plan_code,
             (SELECT count(*)::int FROM restaurant_members m WHERE m.restaurant_id = r.id) AS members,
             (SELECT count(*)::int FROM restaurant_tables x WHERE x.restaurant_id = r.id) AS tables
      FROM restaurants r JOIN subscriptions s ON s.restaurant_id = r.id WHERE r.slug = 'montra'`);
    expect(r).toMatchObject({ name: 'Casa Aurora', is_demo: true, status: 'ativo', plan_code: 'premium', members: 0, tables: 0 });
  });

  test('cada fotografia e modelo do cardápio existe na base de dados, é do próprio restaurante e tem o tipo certo', async () => {
    const items = await rows((tx) => tx<{ name: string; image_url: string; thumb_url: string; model_url: string | null; rid: string }>`
      SELECT i.name, i.image_url, i.thumb_url, i.model_url, i.restaurant_id AS rid FROM menu_items i JOIN restaurants r ON r.id = i.restaurant_id WHERE r.slug = 'montra'`);
    expect(items).toHaveLength(12);
    expect(items.filter((i) => i.model_url).length).toBe(7);
    const assets = await rows((tx) => tx<{ url: string; restaurant_id: string; content_type: string; byte_size: number }>`SELECT '/a/' || id::text AS url, restaurant_id, content_type, byte_size FROM assets`);
    const byUrl = new Map(assets.map((a) => [a.url, a]));
    for (const item of items) {
      expect(byUrl.get(item.image_url)).toMatchObject({ restaurant_id: item.rid, content_type: 'image/jpeg' });
      expect(byUrl.get(item.thumb_url)).toMatchObject({ restaurant_id: item.rid, content_type: 'image/jpeg' });
      if (item.model_url) expect(byUrl.get(item.model_url)).toMatchObject({ restaurant_id: item.rid, content_type: 'model/gltf-binary' });
    }
    expect(assets).toHaveLength(2 + 12 * 2 + 7); // logótipo, capa, fotografia e miniatura de cada prato, e os modelos 3D
    expect(assets.reduce((n, a) => n + a.byte_size, 0)).toBeLessThan(80 * 1024 * 1024); // cabe na quota de um restaurante
  });

  test('o público vê o cardápio (com os modelos 3D, porque o plano os inclui) e descarrega as imagens', async () => {
    const anon = t.anon();
    const r = await anon.get('/api/public/restaurants/montra');
    expect(r.status).toBe(200);
    const menu = r.body;
    expect(menu.restaurant).toMatchObject({ name: 'Casa Aurora', is_demo: true });
    const dishes = menu.categories.flatMap((c: { items: Array<{ model_url: string | null; image_url: string }> }) => c.items);
    expect(dishes).toHaveLength(12);
    const withModel = dishes.filter((d: { model_url: string | null }) => d.model_url);
    expect(withModel).toHaveLength(7);
    const photo = await anon.get(dishes[0].image_url);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    const model = await anon.request('GET', withModel[0].model_url, { keepOpen: true });
    expect(model.status).toBe(200);
    expect(model.headers.get('content-type')).toBe('model/gltf-binary');
    await model.res.body?.cancel();
  });

  test('a página comercial passa a mostrar a demonstração (cardápio e modelo 3D)', async () => {
    const home = await t.anon().get('/');
    expect(home.status).toBe(200);
    const html = String(home.body);
    expect(html).toContain('Casa Aurora');
    for (const id of ['cardapio', 'modelo-3d', 'demonstracao']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('/r/montra?embed=1'); // o cardápio de demonstração, dentro da página
  });

  test('é só uma montra: não recebe pedidos nem chamadas ao empregado, mas mostra 3D e realidade aumentada', async () => {
    const r = await t.anon().get('/api/public/restaurants/montra');
    expect(r.body.capabilities).toEqual({ orders: false, whatsapp: false, model_3d: true, ar: true, waiter_call: false });
  });
});

describe('segunda vez e restaurantes que já existem', () => {
  test('arrancar outra vez não duplica nem altera nada', async () => {
    const before = await rows((tx) => tx<{ n: number; a: number }>`SELECT (SELECT count(*)::int FROM restaurants WHERE slug = 'montra') AS n, (SELECT count(*)::int FROM assets) AS a`);
    const result = await seedShowcase(t.db, t.config);
    expect(result).toEqual({ created: false, slug: 'montra' });
    const after = await rows((tx) => tx<{ n: number; a: number }>`SELECT (SELECT count(*)::int FROM restaurants WHERE slug = 'montra') AS n, (SELECT count(*)::int FROM assets) AS a`);
    expect(after[0]).toEqual(before[0]);
  });

  test('se o endereço já pertence a outro restaurante (real), não lhe toca', async () => {
    const id = await seedRestaurant(t, 'Restaurante Real', { slug: 'restaurante-real' });
    expect(id).toBeTruthy();
    const result = await seedShowcase(t.db, { demoSlug: 'restaurante-real', demoMediaDir: MEDIA });
    expect(result).toEqual({ created: false, slug: 'restaurante-real' });
    const [r] = await rows((tx) => tx<{ name: string; is_demo: boolean }>`SELECT name, is_demo FROM restaurants WHERE slug = 'restaurante-real'`);
    expect(r).toEqual({ name: 'Restaurante Real', is_demo: false });
  });
});

describe('suspender a demonstração', () => {
  test('um restaurante de demonstração suspenso deixa de aparecer na página comercial (que continua a funcionar)', async () => {
    const own = await startTestApp({ env: { DEMO_RESTAURANT_SLUG: 'montra', DEMO_MEDIA_DIR: MEDIA } });
    try {
      await seedShowcase(own.db, own.config);
      await own.db.system((tx) => tx`UPDATE restaurants SET status = 'suspenso' WHERE slug = 'montra'`);
      const home = await own.anon().get('/');
      expect(home.status).toBe(200);
      const html = String(home.body);
      expect(html).not.toContain('Casa Aurora');
      for (const id of ['cardapio', 'modelo-3d', 'demonstracao']) expect(html).not.toContain(`id="${id}"`);
      expect(html).toContain('id="planos"');
    } finally {
      await own.close();
    }
  });
});
