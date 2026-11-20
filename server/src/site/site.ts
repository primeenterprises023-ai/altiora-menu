// Páginas que o servidor entrega diretamente (fora da aplicação de ecrãs): página comercial, aviso de privacidade,
// robots.txt, sitemap.xml, a pré-visualização dos links dos restaurantes e os ficheiros enviados pelos restaurantes (/a/<id>).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PLANS, FEATURE_KEYS, FEATURES } from '../../../shared/plans';
import type { LandingAssets, LandingData, LandingDemo, LandingDish, LandingPlan } from '../../../shared/landing';
import { allergenLabel } from '../../../shared/allergens';
import type { Deps } from '../http/types';
import { loadPublicMenuBySlug } from '../modules/public/routes';
import { renderLanding, renderPrivacy } from './landing';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function html(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });
}

export function createSite(deps: Deps) {
  const { config, db, limiter } = deps;
  const base = config.publicBaseUrl.replace(/\/$/, '');

  // --- ficheiros dos restaurantes ---------------------------------------------------------------
  async function serveAsset(req: Request, id: string, ip: string): Promise<Response> {
    const rate = limiter.hit(`asset:${ip}`, 3000, 60_000);
    if (!rate.ok) return new Response('Demasiados pedidos.', { status: 429, headers: { 'retry-after': String(rate.retryAfterSec) } });
    if (!UUID_RE.test(id)) return new Response('Não encontrado', { status: 404 });
    const etag = await db.system((tx) => tx<{ sha256: string }>`SELECT sha256 FROM assets WHERE id = ${id}`);
    const tag = etag[0] ? `"${etag[0].sha256}"` : null;
    if (!tag) return new Response('Não encontrado', { status: 404, headers: { 'cache-control': 'no-store' } });
    const headers: Record<string, string> = {
      etag: tag,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-robots-tag': 'noindex',
    };
    if (req.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers });
    const rows = await db.system((tx) => tx<{ content_type: string; data: Uint8Array }>`SELECT content_type, data FROM assets WHERE id = ${id}`);
    const row = rows[0];
    if (!row) return new Response('Não encontrado', { status: 404 });
    return new Response(row.data as unknown as BodyInit, { headers: { ...headers, 'content-type': row.content_type, 'content-length': String(row.data.byteLength) } });
  }

  // --- ficheiros gerados pela construção do projeto -----------------------------------------------
  let manifest: LandingAssets | null = null;
  async function landingAssets(): Promise<LandingAssets> {
    if (manifest) return manifest;
    try {
      const m = JSON.parse(await readFile(join(config.webDir, 'asset-manifest.json'), 'utf8')) as Record<string, string>;
      manifest = { css: m['landing.css'] ?? '/assets/landing.css', js: m['landing.js'] ?? '/assets/landing.js', font: m['font'] ?? null };
      return manifest;
    } catch {
      return { css: '/assets/landing.css', js: '/assets/landing.js', font: null };
    }
  }

  let shell: string | null = null;
  async function spaShell(): Promise<string | null> {
    if (shell) return shell;
    try {
      shell = await readFile(join(config.webDir, 'index.html'), 'utf8');
      return shell;
    } catch {
      return null;
    }
  }

  // --- página comercial ---------------------------------------------------------------------------
  /** Reúne os dados da página comercial. Se a base de dados falhar, a página continua a abrir (planos sem preço, sem demonstração). */
  async function landingData(): Promise<{ data: LandingData; degraded: boolean }> {
    type PlanRow = { code: string; name: string; tagline: string; highlighted: boolean; features: string[] };
    type PriceRow = { plan_code: string; currency: string; monthly_cents: string; yearly_cents: string | null };
    let degraded = false;
    const rows = await db
      .as({ role: 'public' }, async (tx) => {
        const plans = await tx<PlanRow>`SELECT code, name, tagline, highlighted, features FROM plans WHERE active ORDER BY display_order, code`;
        const prices = await tx<PriceRow>`SELECT plan_code, currency, monthly_cents, yearly_cents FROM plan_prices ORDER BY (currency = 'AOA') DESC, currency`;
        return { plans, prices };
      })
      .catch(() => {
        degraded = true;
        return {
          plans: DEFAULT_PLANS.map((p): PlanRow => ({ code: p.code, name: p.name, tagline: p.tagline, highlighted: p.highlighted, features: [...p.features] })),
          prices: [] as PriceRow[],
        };
      });
    const plans: LandingPlan[] = rows.plans.map((p) => {
      const price = rows.prices.find((x) => x.plan_code === p.code);
      return {
        code: p.code, name: p.name, tagline: p.tagline, highlighted: p.highlighted,
        features: FEATURE_KEYS.map((k) => ({ key: k, label: FEATURES[k].label, description: FEATURES[k].description, included: p.features.includes(k) })),
        price: price ? { currency: price.currency, monthly_cents: Number(price.monthly_cents), yearly_cents: price.yearly_cents === null ? null : Number(price.yearly_cents) } : null,
      };
    });

    let demo: LandingDemo | null = null;
    const menu = degraded ? null : await loadPublicMenuBySlug(deps, config.demoSlug).catch(() => null);
    if (menu) {
      const toDish = (c: string, i: (typeof menu.categories)[number]['items'][number]): LandingDish => ({
        name: i.name, description: i.description ?? '', price_cents: i.price_cents, category: c, image_url: i.image_url, thumb_url: i.thumb_url, model_url: i.model_url,
        allergens: i.allergens.map(allergenLabel),
      });
      // a página comercial só mostra pratos disponíveis (um prato esgotado não serve de exemplo)
      const shown = menu.categories.map((c) => ({ name: c.name, items: c.items.filter((i) => i.available) }));
      const all = shown.flatMap((c) => c.items.map((i) => toDish(c.name, i)));
      // o mostruário mistura categorias: no máximo 3 pratos de cada
      const perCategory = shown.flatMap((c) => c.items.slice(0, 3).map((i) => toDish(c.name, i)));
      demo = {
        slug: menu.restaurant.slug, name: menu.restaurant.name, description: menu.restaurant.description ?? '', currency: menu.restaurant.currency,
        logo_url: menu.restaurant.logo_url, cover_url: menu.restaurant.cover_url,
        dishes: perCategory.slice(0, 12),
        model_dish: all.find((d) => d.model_url && d.image_url) ?? null,
      };
    }
    return { data: { base_url: base, plans, demo, contacts: config.commercial, year: new Date().getFullYear() }, degraded };
  }

  const cache = new Map<string, { at: number; body: string }>();
  /** Páginas comerciais: guardadas 60 s; uma versão sem base de dados nunca é guardada nem publicada em cache. */
  async function commercialPage(key: 'landing' | 'privacy'): Promise<Response> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return html(hit.body, INDEXABLE);
    const { data, degraded } = await landingData();
    const assets = await landingAssets();
    const body = key === 'landing' ? renderLanding(data, assets) : renderPrivacy(data, assets);
    if (degraded) return html(body, { ...INDEXABLE, 'cache-control': 'no-store' });
    cache.set(key, { at: Date.now(), body });
    return html(body, INDEXABLE);
  }

  const INDEXABLE = { 'x-robots-tag': 'index, follow, max-image-preview:large', 'cache-control': 'public, max-age=300, stale-while-revalidate=600' };

  async function restaurantShell(slug: string): Promise<Response | null> {
    const index = await spaShell();
    if (!index || !SLUG_RE.test(slug) || slug.length > 60) return null;
    const info = await db
      .as({ role: 'public' }, async (tx) => {
        const [r] = await tx<{ restaurant_id: string; restaurant_status: string }>`SELECT restaurant_id, restaurant_status FROM resolve_restaurant_slug(${slug})`;
        if (!r || r.restaurant_status !== 'ativo') return null;
        await tx.setContext({ restaurantId: r.restaurant_id });
        const [x] = await tx<{ name: string; description: string | null; logo_url: string | null; cover_url: string | null; is_demo: boolean }>`
          SELECT name, description, logo_url, cover_url, is_demo FROM restaurants WHERE id = ${r.restaurant_id}`;
        return x ?? null;
      })
      .catch(() => null);
    if (!info) return null;
    const title = `${info.name} — Cardápio digital`;
    const description = (info.description ?? `Veja o cardápio de ${info.name}.`).slice(0, 200);
    const image = info.cover_url ?? info.logo_url;
    const imageUrl = image ? (image.startsWith('/') ? `${base}${image}` : image) : `${base}/landing/og.jpg`;
    const tags = [
      `<meta name="description" content="${esc(description)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="ALTIORA MENU" />`,
      `<meta property="og:title" content="${esc(title)}" />`,
      `<meta property="og:description" content="${esc(description)}" />`,
      `<meta property="og:url" content="${esc(`${base}/r/${slug}`)}" />`,
      `<meta property="og:image" content="${esc(imageUrl)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
    ].join('\n    ');
    let out = index.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`).replace('</head>', `    ${tags}\n  </head>`);
    // só o cardápio de demonstração aparece nas pesquisas; os restantes são públicos mas não indexados
    if (info.is_demo) out = out.replace('<meta name="robots" content="noindex, nofollow" />', '<meta name="robots" content="index, follow" />');
    return html(out, { 'cache-control': 'no-cache', ...(info.is_demo ? { 'x-robots-tag': 'index, follow' } : {}) });
  }

  return async function site(req: Request, url: URL, ip: string): Promise<Response | null> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    const p = url.pathname;
    if (p.startsWith('/a/')) return serveAsset(req, p.slice(3), ip);
    if (p === '/') return commercialPage('landing');
    if (p === '/privacidade') return commercialPage('privacy');
    if (p === '/robots.txt') {
      const txt = ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /menu/', 'Disallow: /pedido/', '', `Sitemap: ${base}/sitemap.xml`, ''].join('\n');
      return new Response(txt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-robots-tag': 'all' } });
    }
    if (p === '/sitemap.xml') {
      const demo = await loadPublicMenuBySlug(deps, config.demoSlug).catch(() => null);
      const urls = [`${base}/`, `${base}/privacidade`, ...(demo ? [`${base}/r/${demo.restaurant.slug}`] : [])];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
      return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-robots-tag': 'all' } });
    }
    const m = /^\/r\/([^/]+)\/?$/.exec(p);
    if (m) return restaurantShell(m[1]!);
    return null;
  };
}
