// Página comercial do ALTIORA MENU e aviso de privacidade: o que o servidor entrega, a segurança dos textos,
// os preços definidos pela Altiora e o comportamento sem restaurante de demonstração.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { LandingContacts, LandingData, LandingDish, LandingPlan } from '../../shared/landing';
import { FEATURE_KEYS, FEATURES, type FeatureKey } from '../../shared/plans';
import { planBullets, renderLanding, renderPrivacy, safeUrl } from '../src/site/landing';
import { seedMenu, seedRestaurant, startTestApp, type TestApp } from './helpers';

const ASSETS = { css: '/assets/landing.abc.css', js: '/assets/landing.abc.js', font: '/assets/font.abc.woff' };
const NO_CONTACTS: LandingContacts = { email: null, phone: null, whatsapp: null, address: null };

const plan = (code: string, name: string, keys: FeatureKey[], extra: Partial<LandingPlan> = {}): LandingPlan => ({
  code,
  name,
  tagline: `${name}: frase`,
  highlighted: false,
  features: FEATURE_KEYS.map((k) => ({ key: k, label: FEATURES[k].label, description: FEATURES[k].description, included: keys.includes(k) })),
  price: null,
  ...extra,
});

const dish = (name: string, extra: Partial<LandingDish> = {}): LandingDish => ({
  name,
  description: 'Descrição de teste',
  price_cents: 450_000,
  category: 'Pratos',
  image_url: '/a/11111111-1111-4111-8111-111111111111',
  thumb_url: '/a/22222222-2222-4222-8222-222222222222',
  model_url: null,
  allergens: ['Glúten'],
  ...extra,
});

const STARTER = plan('starter', 'Starter', ['menu', 'qr_codes', 'basic_products']);
const PRO = plan('pro', 'Pro', ['menu', 'qr_codes', 'basic_products', 'orders', 'tables'], { highlighted: true });
const PREMIUM = plan('premium', 'Premium', ['menu', 'qr_codes', 'basic_products', 'orders', 'tables', 'model_3d', 'ar']);

const data = (over: Partial<LandingData> = {}): LandingData => ({ base_url: 'https://menu.exemplo.ao', plans: [STARTER, PRO, PREMIUM], demo: null, contacts: NO_CONTACTS, year: 2026, ...over });

const demoWith = (dishes: LandingDish[], model: LandingDish | null = null): NonNullable<LandingData['demo']> => ({
  slug: 'demo',
  name: 'Casa Aurora',
  description: 'Restaurante de demonstração',
  currency: 'AOA',
  logo_url: null,
  cover_url: null,
  dishes,
  model_dish: model,
});

/** Os valores em dinheiro usam espaços sem quebra (U+00A0) para nunca partirem a meio do número. */
const nb = (s: string): string => s.replace(/ /g, ' ');

/** Todas as ligações «#algo» de uma página têm de ter destino nessa mesma página. */
const deadAnchors = (html: string): string[] => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
  return [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!))].filter((h) => !ids.has(h));
};

const ldJson = (html: string): { '@graph': Array<Record<string, any>> } => {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!);
};

describe('safeUrl', () => {
  test('aceita endereços do próprio site e https', () => {
    expect(safeUrl('/a/abc')).toBe('/a/abc');
    expect(safeUrl('https://cdn.exemplo.ao/x.jpg')).toBe('https://cdn.exemplo.ao/x.jpg');
  });
  test('recusa o resto', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//outro-site.com/x', '/\\outro-site.com', 'http://inseguro.com/x', 'ftp://x', '', null, undefined]) {
      expect(safeUrl(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe('planBullets', () => {
  test('cada plano mostra só o que acrescenta ao anterior', () => {
    expect(planBullets([STARTER, PRO, PREMIUM], 0)).toEqual({ lead: null, items: ['Cardápio digital interativo', 'QR Code do restaurante em PDF', 'Gestão de produtos'] });
    const pro = planBullets([STARTER, PRO, PREMIUM], 1);
    expect(pro.lead).toBe('Tudo do plano Starter, e ainda:');
    expect(pro.items).toEqual([FEATURES.orders.label, FEATURES.tables.label]);
    const premium = planBullets([STARTER, PRO, PREMIUM], 2);
    expect(premium.lead).toBe('Tudo do plano Pro, e ainda:');
    expect(premium.items).toEqual([FEATURES.model_3d.label, FEATURES.ar.label]);
  });
  test('um plano que não contém o anterior lista tudo o que inclui', () => {
    const odd = plan('odd', 'Outro', ['menu', 'stats']);
    const r = planBullets([STARTER, odd], 1);
    expect(r.lead).toBeNull();
    expect(r.items).toEqual([FEATURES.menu.label, FEATURES.stats.label]);
  });
  test('um plano igual ao anterior di-lo', () => {
    const same = plan('copia', 'Cópia', ['menu', 'qr_codes', 'basic_products']);
    expect(planBullets([STARTER, same], 1)).toEqual({ lead: 'Inclui o mesmo que o plano Starter.', items: [] });
  });
});

describe('renderLanding (sem restaurante de demonstração)', () => {
  const html = renderLanding(data(), ASSETS);

  test('documento completo, em português de Angola, com SEO', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="pt-AO">');
    expect(html).toContain('<title>ALTIORA MENU');
    expect(html).toContain('<link rel="canonical" href="https://menu.exemplo.ao/" />');
    expect(html).toContain('property="og:image" content="https://menu.exemplo.ao/landing/og.jpg"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="description"');
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
  });
  test('usa os ficheiros construídos e nenhum programa embutido', () => {
    expect(html).toContain(`href="${ASSETS.css}"`);
    expect(html).toContain(`<script type="module" src="${ASSETS.js}"></script>`);
    expect(html).toContain(`rel="preload" href="${ASSETS.font}"`);
    // a política de segurança não permite programas dentro da página: só o JSON-LD (dados) e o src do ficheiro
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!);
    for (const attrs of scripts) expect(attrs.includes('src=') || attrs.includes('application/ld+json')).toBe(true);
    expect(html).not.toMatch(/\son[a-z]+="/); // sem onclick="" e semelhantes
  });
  test('as secções de demonstração não aparecem sem restaurante de demonstração', () => {
    for (const id of ['cardapio', 'modelo-3d', 'demonstracao']) expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('lp-qrcard');
    expect(html).not.toContain('Ver um cardápio de exemplo');
    expect(html).not.toContain('href="#cardapio"');
  });
  test('as secções fixas existem e todas as âncoras do menu têm destino', () => {
    for (const id of ['como-funciona', 'beneficios', 'funcionalidades', 'planos', 'perguntas', 'contacto', 'conteudo']) expect(html).toContain(`id="${id}"`);
    expect(deadAnchors(html)).toEqual([]);
  });
  test('planos sem preço dizem «Preço sob consulta» e não inventam valores', () => {
    expect((html.match(/Preço sob consulta/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/por mês/);
    expect(ldJson(html)['@graph'].find((n) => n['@type'] === 'SoftwareApplication')!.offers).toBeUndefined();
  });
  test('o plano em destaque é assinalado e cada plano leva ao formulário', () => {
    expect(html.match(/Mais escolhido/g)?.length).toBe(1);
    for (const code of ['starter', 'pro', 'premium']) expect(html).toContain(`href="#contacto" data-plan="${code}"`);
    expect(html).toContain('<option value="pro">Pro</option>');
  });
  test('perguntas frequentes visíveis e no JSON-LD, com o mesmo texto', () => {
    const faq = ldJson(html)['@graph'].find((n) => n['@type'] === 'FAQPage')!;
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(8);
    for (const q of faq.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>) {
      expect(html).toContain(q.name.replace(/'/g, '&#39;'));
      expect(html).toContain(q.acceptedAnswer.text.replace(/'/g, '&#39;'));
    }
  });
  test('o cliente não paga pelo site: nenhuma secção de pagamento online', () => {
    expect(html).toContain('O sistema cobra pagamentos aos clientes?');
    expect(html).not.toMatch(/pagar (agora|online)|cartão de crédito|multicaixa/i);
  });
  test('formulário com consentimento, campo-isca escondido e ligação à privacidade', () => {
    expect(html).toContain('id="lp-form"');
    expect(html).toContain('name="consent"');
    expect(html).toContain('name="website"');
    expect(html).toContain('class="lp-hp" aria-hidden="true"');
    expect(html).toContain('href="/privacidade"');
  });
  test('rodapé com o nome da empresa e o ano', () => {
    expect(html).toContain('© 2026 Altiora Grupo');
    expect(html).not.toContain('Altiora Group');
  });
  test('sem contactos configurados, nenhum contacto é inventado', () => {
    expect(html).not.toContain('class="lp-contact-list"');
    expect(html).not.toContain('mailto:');
    expect(html).not.toContain('tel:');
    expect(html).not.toContain('wa.me');
  });
});

describe('renderLanding (com restaurante de demonstração)', () => {
  const model = dish('Muamba de galinha', { model_url: '/a/33333333-3333-4333-8333-333333333333', category: 'Pratos' });
  const dishes = [dish('Pastéis de bacalhau', { category: 'Entradas' }), model, dish('Pudim de leite', { category: 'Sobremesas', image_url: null, thumb_url: null, allergens: [] })];
  const html = renderLanding(data({ demo: demoWith(dishes, model) }), ASSETS);

  test('mostra os pratos, o selo 3D e os filtros por categoria', () => {
    for (const n of ['Pastéis de bacalhau', 'Muamba de galinha', 'Pudim de leite']) expect(html).toContain(n);
    expect(html).toContain(nb('4 500 Kz'));
    expect(html.match(/class="lp-tag">3D</g)?.length).toBe(1);
    expect(html).toContain('data-cat="Entradas"');
    expect(html).toContain('data-cat="Sobremesas"');
    expect(html).toContain('lp-dish-noimg'); // prato sem fotografia: sem imagem partida
    expect(html).toContain('class="lp-chips" role="group" aria-label="Filtrar por categoria" hidden'); // os filtros só aparecem quando o JavaScript os liga
  });
  test('a demonstração em 3D usa o modelo do prato e avisa que é um modelo de demonstração', () => {
    expect(html).toContain('id="modelo-3d"');
    expect(html).toContain('data-model="/a/33333333-3333-4333-8333-333333333333"');
    expect(html).toContain('Modelo de demonstração, gerado por computador.');
    expect(html).toContain('href="#modelo-3d"');
  });
  test('a demonstração interativa abre o cardápio real em modo incorporado', () => {
    expect(html).toContain('<iframe title="Cardápio de demonstração interativo" src="/r/demo?embed=1"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('href="/r/demo"');
  });
  test('o QR Code do início é verdadeiro e aponta para o restaurante de demonstração', () => {
    const svg = /<figure class="lp-qrcard">[\s\S]*?<svg[\s\S]*?<\/svg>/.exec(html);
    expect(svg).not.toBeNull();
    expect(svg![0]).toContain('<path');
  });
  test('sem modelo 3D, a secção 3D não aparece mas o resto da demonstração sim', () => {
    const noModel = renderLanding(data({ demo: demoWith(dishes, null) }), ASSETS);
    expect(noModel).not.toContain('id="modelo-3d"');
    expect(noModel).not.toContain('lp-3d-stage');
    expect(noModel).toContain('id="cardapio"');
    expect(noModel).toContain('id="demonstracao"');
  });
  test('um restaurante de demonstração sem pratos não mostra o cardápio de exemplo', () => {
    const empty = renderLanding(data({ demo: demoWith([]) }), ASSETS);
    expect(empty).not.toContain('id="cardapio"');
  });
});

describe('renderLanding: preços definidos pela Altiora', () => {
  const priced = data({
    plans: [
      STARTER,
      PRO,
      plan('ouro', 'Ouro', ['menu', 'qr_codes', 'basic_products', 'orders', 'tables'], { price: { currency: 'AOA', monthly_cents: 7_500_000, yearly_cents: 75_000_000 } }),
      plan('euro', 'Euro', ['menu'], { price: { currency: 'EUR', monthly_cents: 9_950, yearly_cents: null } }),
    ],
  });
  const html = renderLanding(priced, ASSETS);
  test('mostra o valor mensal, o anual e a moeda de cada plano', () => {
    expect(html).toContain(nb('75 000 Kz'));
    expect(html).toContain(`ou ${nb('750 000 Kz')} por ano`);
    expect(html).toContain(nb('99,50 €'));
    expect(html.match(/por mês/g)?.length).toBe(2);
    expect(html.match(/Preço sob consulta/g)?.length).toBe(2);
  });
  test('o JSON-LD só tem ofertas para os planos com preço', () => {
    const offers = ldJson(html)['@graph'].find((n) => n['@type'] === 'SoftwareApplication')!.offers as Array<Record<string, string>>;
    expect(offers).toEqual([
      { '@type': 'Offer', name: 'Plano Ouro', price: '75000.00', priceCurrency: 'AOA' },
      { '@type': 'Offer', name: 'Plano Euro', price: '99.50', priceCurrency: 'EUR' },
    ]);
  });
});

describe('renderLanding: contactos', () => {
  const contacts: LandingContacts = { email: 'comercial@exemplo.ao', phone: '+244 900 000 000', whatsapp: '244900000000', address: 'Talatona, Luanda' };
  const html = renderLanding(data({ contacts }), ASSETS);
  test('mostra só os contactos configurados, com ligações certas', () => {
    expect(html).toContain('href="mailto:comercial@exemplo.ao"');
    expect(html).toContain('href="tel:+244900000000"');
    expect(html).toContain('href="https://wa.me/244900000000?text=');
    expect(html).toContain('Talatona, Luanda');
    const ld = ldJson(html)['@graph'].find((n) => n['@type'] === 'Organization')!;
    expect(ld.contactPoint).toMatchObject({ email: 'comercial@exemplo.ao', telephone: '+244 900 000 000' });
  });
  test('só alguns contactos: os outros não aparecem', () => {
    const partial = renderLanding(data({ contacts: { ...NO_CONTACTS, email: 'a@b.ao' } }), ASSETS);
    expect(partial).toContain('mailto:a@b.ao');
    expect(partial).not.toContain('tel:');
    expect(partial).not.toContain('wa.me');
  });
});

describe('segurança dos textos', () => {
  const evil = '<script>alert(1)</script>';
  const evilDish = dish(`Prato ${evil}`, { description: `"><img src=x onerror=alert(1)>`, category: `Cat ${evil}`, image_url: 'javascript:alert(1)', thumb_url: 'data:text/html,<script>alert(1)</script>', allergens: [evil] });
  const evilModel = dish('Modelo', { model_url: '/a/33333333-3333-4333-8333-333333333333', image_url: '//outro-site.com/x.jpg' });
  const html = renderLanding(
    data({
      plans: [plan('x', `Plano ${evil}`, ['menu'], { tagline: `"><b>${evil}`, price: { currency: 'AOA', monthly_cents: 100, yearly_cents: null } })],
      demo: { ...demoWith([evilDish, evilModel], evilModel), name: `Casa ${evil}`, slug: 'demo', logo_url: 'javascript:alert(2)' },
      contacts: { email: `a"@b.ao`, phone: `+244 <b>1`, whatsapp: '244900000000', address: evil },
    }),
    ASSETS,
  );
  test('nenhum texto da base de dados ou da configuração entra sem tratamento', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('onerror=alert(1)>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('src="//outro-site.com');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  test('o JSON-LD não consegue fechar a etiqueta <script>', () => {
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(block).not.toContain('</');
    expect(() => JSON.parse(block)).not.toThrow();
  });
  test('o aviso de privacidade também trata os contactos', () => {
    const p = renderPrivacy(data({ contacts: { ...NO_CONTACTS, email: `"><script>alert(1)</script>@x.ao` } }), ASSETS);
    expect(p).not.toContain('<script>alert');
  });
});

describe('renderPrivacy', () => {
  test('explica os dados em linguagem simples e não promete o que o sistema não faz', () => {
    const p = renderPrivacy(data({ contacts: { ...NO_CONTACTS, email: 'privacidade@exemplo.ao' } }), ASSETS);
    expect(p).toContain('<h1>Como tratamos os seus dados</h1>');
    expect(p).toContain('formulário');
    expect(p).toContain('mailto:privacidade@exemplo.ao');
    expect(p).toContain('Cada restaurante só tem acesso aos seus dados');
    expect(p).toContain('canonical" href="https://menu.exemplo.ao/privacidade"');
    // o cabeçalho e o rodapé levam de volta às secções da página inicial (e não a âncoras que só existem lá)
    expect(p).toContain('href="/#planos"');
    expect(p).toContain('href="/#perguntas"');
    expect(deadAnchors(p)).toEqual([]);
    expect(p).not.toMatch(/em conformidade com|certificad|garantimos/i);
  });
  test('sem e-mail configurado, remete para o formulário', () => {
    const p = renderPrivacy(data(), ASSETS);
    expect(p).toContain('href="/#contacto"');
    expect(p).not.toContain('mailto:');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// o servidor a sério: base de dados, ficheiros e cabeçalhos
// ---------------------------------------------------------------------------------------------------------------------
describe('GET / e /privacidade no servidor', () => {
  let t: TestApp;
  let slug: string;

  beforeAll(async () => {
    slug = 'casa-demo-teste';
    t = await startTestApp({ env: { DEMO_RESTAURANT_SLUG: slug, COMMERCIAL_EMAIL: 'comercial@exemplo.ao' } });
    const id = await seedRestaurant(t, 'Casa Demo Teste', { slug });
    await seedMenu(t, id);
    await t.db.system((tx) => tx`UPDATE plans SET highlighted = (code = 'pro')`);
    await t.db.system((tx) => tx`INSERT INTO plan_prices (plan_code, currency, monthly_cents, yearly_cents) VALUES ('pro', 'AOA', 2500000, 25000000)`);
  });
  afterAll(async () => {
    await t.close();
  });

  const get = async (path: string) => {
    const res = await t.app.fetch(new Request(`http://localhost${path}`), { ip: '10.9.9.9' });
    return { res, text: await res.text() };
  };

  test('a página inicial vem da base de dados: planos, preços e cardápio de exemplo', async () => {
    const { res, text } = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-robots-tag')).toContain('index');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    expect(text).toContain('Starter');
    expect(text).toContain(nb('25 000 Kz'));
    expect(text).toContain('Muamba de galinha');
    // o que o restaurante não mostra aos clientes também não aparece como exemplo: esgotado, desativado, categoria escondida
    expect(text).not.toContain('Calulu (esgotado)');
    expect(text).not.toContain('Prato desativado');
    expect(text).not.toContain('Prato da categoria escondida');
    expect(text).toContain(`src="/r/${slug}?embed=1"`);
    expect(text).toContain('mailto:comercial@exemplo.ao');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
  });
  test('/privacidade abre e usa o e-mail configurado', async () => {
    const { res, text } = await get('/privacidade');
    expect(res.status).toBe(200);
    expect(text).toContain('Como tratamos os seus dados');
    expect(text).toContain('mailto:comercial@exemplo.ao');
  });
  test('o formulário comercial grava o contacto e não deixa o robô entrar', async () => {
    const ok = await t.app.fetch(
      new Request('http://localhost/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: t.config.publicBaseUrl },
        body: JSON.stringify({ name: 'Ana Ferreira', business: 'Mirante', phone: '+244 923 000 111', email: '', message: 'Plano de interesse: Pro', consent: true, website: '' }),
      }),
      { ip: '10.9.9.10' },
    );
    expect(ok.status).toBe(201);
    const bot = await t.app.fetch(
      new Request('http://localhost/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: t.config.publicBaseUrl },
        body: JSON.stringify({ name: 'Robô', phone: '+244 923 000 222', consent: true, website: 'http://spam.example' }),
      }),
      { ip: '10.9.9.11' },
    );
    expect(bot.status).toBeLessThan(300); // o robô recebe «tudo bem», mas nada é guardado
    const rows = await t.db.system((tx) => tx<{ name: string }>`SELECT name FROM leads ORDER BY created_at`);
    expect(rows.map((r) => r.name)).toEqual(['Ana Ferreira']);
  });
});
