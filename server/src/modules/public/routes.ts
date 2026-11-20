// Rotas públicas (sem conta): o cliente abre o menu pelo QR Code da mesa, envia o pedido e acompanha o estado.
import { CreateOrderInput } from '../../../../shared/schemas';
import { parseHours } from '../../../../shared/hours';
import type { FeatureKey } from '../../../../shared/plans';
import type { MenuOption, PlaceOrderResponse, PublicMenu } from '../../../../shared/types';
import { lockIdempotencyKey, lockTableOrdering, pgCode, pgConstraint, type Tx } from '../../db/client';
import { HttpError, badRequest, conflict, notFound, tooMany } from '../../lib/errors';
import { randomToken } from '../../lib/crypto';
import { restaurantFeatures } from '../../lib/plans';
import { json } from '../../http/respond';
import { sseResponse } from '../../http/sse';
import type { Ctx, Deps, RouteSpec } from '../../http/types';
import { insertOrder, listSessionOrders, loadPublicOrder, priceOrder } from '../orders/service';
import { currentSessionId, ensureTableSession } from '../orders/table-sessions';
import type { OrderStatus } from '../../../../shared/status';

const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,100}$/;
const MAX_STREAMS_PER_IP = 80;

function tableToken(ctx: Ctx): string {
  const t = ctx.params.token ?? '';
  // formato inválido: responde já, sem tocar na base de dados
  if (!TOKEN_RE.test(t)) throw notFound('QR Code inválido ou desativado.', 'TABLE_NOT_FOUND');
  return t;
}

function orderCode(ctx: Ctx): string {
  const c = ctx.params.code ?? '';
  if (!TOKEN_RE.test(c)) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  return c;
}

interface ResolvedTable {
  table_id: string;
  restaurant_id: string;
  table_number: number;
  table_label: string | null;
  table_active: boolean;
  restaurant_status: string;
  accepting_orders: boolean;
}

/** Descobre mesa e restaurante a partir do token do QR Code e fixa o contexto da transação. */
async function resolveTable(tx: Tx, token: string): Promise<ResolvedTable> {
  const [t] = await tx<ResolvedTable>`
    SELECT table_id, restaurant_id, table_number, table_label, table_active, restaurant_status, accepting_orders
    FROM resolve_table_token(${token})`;
  if (!t) throw notFound('QR Code inválido ou desativado.', 'TABLE_NOT_FOUND');
  if (t.restaurant_status !== 'ativo') {
    throw new HttpError(403, 'RESTAURANT_UNAVAILABLE', 'Este restaurante não está disponível neste momento.');
  }
  if (!t.table_active) {
    throw new HttpError(403, 'TABLE_UNAVAILABLE', 'Esta mesa não está disponível. Peça ajuda a um empregado.');
  }
  await tx.setContext({ restaurantId: t.restaurant_id, tableId: t.table_id });
  return t;
}

// --- cardápio público (por mesa: /menu/<token>, ou do restaurante: /r/<slug>) -------------------------
interface RestaurantRow {
  slug: string; name: string; description: string | null; logo_url: string | null; cover_url: string | null; accent_color: string | null;
  service_fee_bps: number; accepting_orders: boolean; address: string | null; phone: string | null; email: string | null;
  whatsapp: string | null; maps_url: string | null; opening_hours: unknown; timezone: string; currency: string;
  theme: 'dark' | 'light'; font: 'serif' | 'sans'; is_demo: boolean;
}

/** Lê restaurante, categorias, pratos e opções (só o que o cliente pode ver). As funcionalidades do plano aplicam-se depois. */
async function buildMenu(tx: Tx, rid: string, table: { number: number; label: string | null; id: string } | null): Promise<PublicMenu> {
  const [r] = await tx<RestaurantRow>`
    SELECT slug, name, description, logo_url, cover_url, accent_color, service_fee_bps, accepting_orders, address, phone, email, whatsapp,
           maps_url, opening_hours, timezone, currency, theme, font, is_demo
    FROM restaurants WHERE id = ${rid}`;
  const cats = await tx<{ id: string; name: string }>`
    SELECT id, name FROM categories WHERE restaurant_id = ${rid} ORDER BY display_order, lower(name)`;
  const items = await tx<{
    id: string; category_id: string; name: string; description: string | null; image_url: string | null; thumb_url: string | null;
    model_url: string | null; ingredients: string[]; allergens: string[]; price_cents: string; available: boolean;
  }>`SELECT id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available
     FROM menu_items WHERE restaurant_id = ${rid} ORDER BY display_order, lower(name)`;
  const opts = await tx<{ id: string; menu_item_id: string; name: string; price_delta_cents: string; kind: 'extra' | 'size' }>`
    SELECT id, menu_item_id, name, price_delta_cents, kind FROM menu_item_options
    WHERE restaurant_id = ${rid} ORDER BY display_order, kind DESC, lower(name)`;
  let call: PublicMenu['waiter_call'] = null;
  if (table) {
    const [c] = await tx<{ id: string; created_at: Date }>`SELECT id, created_at FROM waiter_calls WHERE table_id = ${table.id} AND status = 'aberta'`;
    if (c) call = { id: c.id, created_at: new Date(c.created_at).toISOString() };
  }

  const optsByItem = new Map<string, MenuOption[]>();
  for (const o of opts) {
    const list = optsByItem.get(o.menu_item_id) ?? [];
    list.push({ id: o.id, name: o.name, price_delta_cents: Number(o.price_delta_cents), kind: o.kind });
    optsByItem.set(o.menu_item_id, list);
  }
  const categories = cats
    .map((c) => ({
      id: c.id,
      name: c.name,
      items: items
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          id: i.id, name: i.name, description: i.description, image_url: i.image_url, thumb_url: i.thumb_url, model_url: i.model_url,
          ingredients: i.ingredients, allergens: i.allergens, price_cents: Number(i.price_cents), available: i.available,
          options: optsByItem.get(i.id) ?? [],
        })),
    }))
    .filter((c) => c.items.length > 0);

  return {
    restaurant: {
      slug: r!.slug, name: r!.name, description: r!.description, logo_url: r!.logo_url, cover_url: r!.cover_url, accent_color: r!.accent_color,
      service_fee_bps: r!.service_fee_bps, address: r!.address, phone: r!.phone, email: r!.email, whatsapp: r!.whatsapp, maps_url: r!.maps_url,
      opening_hours: parseHours(r!.opening_hours), timezone: r!.timezone, currency: r!.currency, theme: r!.theme, font: r!.font,
      is_demo: r!.is_demo, show_brand: true,
    },
    table: table ? { number: table.number, label: table.label } : null,
    accepting_orders: r!.accepting_orders,
    capabilities: { orders: false, whatsapp: false, model_3d: false, ar: false, waiter_call: false },
    waiter_call: call,
    categories,
  };
}

/** Aplica o plano do restaurante: o que não está incluído não sai do servidor (nem o modelo 3D, nem a marca em falta). */
function applyPlan(menu: PublicMenu, features: ReadonlySet<FeatureKey>): PublicMenu {
  const r = menu.restaurant;
  const has3d = features.has('model_3d');
  const canOrder = menu.table !== null && features.has('orders') && !r.is_demo;
  return {
    ...menu,
    restaurant: {
      ...r,
      whatsapp: features.has('whatsapp_orders') ? r.whatsapp : null,
      accent_color: features.has('advanced_branding') ? r.accent_color : null,
      theme: features.has('advanced_branding') ? r.theme : 'dark',
      font: features.has('exclusive_branding') ? r.font : 'serif',
      show_brand: !features.has('exclusive_branding'),
    },
    capabilities: {
      orders: canOrder,
      whatsapp: features.has('whatsapp_orders') && !!r.whatsapp && !r.is_demo,
      model_3d: has3d,
      ar: has3d && features.has('ar'),
      waiter_call: canOrder,
    },
    waiter_call: canOrder ? menu.waiter_call : null,
    categories: has3d ? menu.categories : menu.categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, model_url: null })) })),
  };
}

// --- GET /api/public/menu/:token ----------------------------------------------------------------
async function getMenu(ctx: Ctx): Promise<Response> {
  const token = tableToken(ctx);
  const { menu, rid } = await ctx.deps.db.as({ role: 'public' }, async (tx) => {
    const t = await resolveTable(tx, token);
    return { rid: t.restaurant_id, menu: await buildMenu(tx, t.restaurant_id, { number: t.table_number, label: t.table_label, id: t.table_id }) };
  });
  return json(applyPlan(menu, await restaurantFeatures(ctx.deps.db, rid)));
}

// --- GET /api/public/restaurants/:slug (página do restaurante, sem mesa) ------------------------
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function getRestaurantMenu(ctx: Ctx): Promise<Response> {
  const slug = ctx.params.slug ?? '';
  if (!SLUG_RE.test(slug) || slug.length > 60) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
  const { menu, rid } = await ctx.deps.db.as({ role: 'public' }, async (tx) => {
    const [r] = await tx<{ restaurant_id: string; restaurant_status: string }>`SELECT restaurant_id, restaurant_status FROM resolve_restaurant_slug(${slug})`;
    if (!r) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
    if (r.restaurant_status !== 'ativo') throw new HttpError(403, 'RESTAURANT_UNAVAILABLE', 'Este restaurante não está disponível neste momento.');
    await tx.setContext({ restaurantId: r.restaurant_id });
    return { rid: r.restaurant_id, menu: await buildMenu(tx, r.restaurant_id, null) };
  });
  return json(applyPlan(menu, await restaurantFeatures(ctx.deps.db, rid)));
}

/** Para a página comercial e para os motores de busca: o cardápio público de um restaurante ativo, ou null. */
export async function loadPublicMenuBySlug(deps: Deps, slug: string): Promise<PublicMenu | null> {
  if (!SLUG_RE.test(slug) || slug.length > 60) return null;
  const found = await deps.db.as({ role: 'public' }, async (tx) => {
    const [r] = await tx<{ restaurant_id: string; restaurant_status: string }>`SELECT restaurant_id, restaurant_status FROM resolve_restaurant_slug(${slug})`;
    if (!r || r.restaurant_status !== 'ativo') return null;
    await tx.setContext({ restaurantId: r.restaurant_id });
    return { rid: r.restaurant_id, menu: await buildMenu(tx, r.restaurant_id, null) };
  });
  return found ? applyPlan(found.menu, await restaurantFeatures(deps.db, found.rid)) : null;
}

// --- Chamar o garçom -----------------------------------------------------------------------------
async function callWaiter(ctx: Ctx): Promise<Response> {
  const token = tableToken(ctx);
  const lim = ctx.deps.limiter.hit(`pub-call-table:${token}`, 6, 600_000);
  if (!lim.ok) throw tooMany('Já chamou o garçom várias vezes. Aguarde um momento.', lim.retryAfterSec, 'CALL_TOO_FAST');
  const out = await ctx.deps.db.as({ role: 'public' }, async (tx) => {
    const t = await resolveTable(tx, token);
    const [f] = await tx<{ ok: boolean }>`SELECT restaurant_has_feature('orders') AS ok`;
    const [d] = await tx<{ is_demo: boolean }>`SELECT is_demo FROM restaurants WHERE id = ${t.restaurant_id}`;
    if (!f?.ok || d?.is_demo) throw new HttpError(403, 'PLAN_FEATURE', 'Este restaurante não tem o botão «Chamar o garçom» ativo.');
    const [made] = await tx<{ id: string; created_at: Date }>`
      INSERT INTO waiter_calls (restaurant_id, table_id, table_number, table_label)
      VALUES (${t.restaurant_id}, ${t.table_id}, ${t.table_number}, ${t.table_label})
      ON CONFLICT (table_id) WHERE status = 'aberta' DO NOTHING
      RETURNING id, created_at`;
    if (made) return { restaurantId: t.restaurant_id, call: made, isNew: true, table: t };
    const [open] = await tx<{ id: string; created_at: Date }>`SELECT id, created_at FROM waiter_calls WHERE table_id = ${t.table_id} AND status = 'aberta'`;
    return { restaurantId: t.restaurant_id, call: open!, isNew: false, table: t };
  });
  if (out.isNew) {
    ctx.deps.hub.publishRestaurant(out.restaurantId, {
      type: 'waiter.call', call_id: out.call.id, table_number: out.table.table_number, table_label: out.table.table_label, at: new Date().toISOString(),
    });
  }
  return json({ call: { id: out.call.id, created_at: new Date(out.call.created_at).toISOString() } }, out.isNew ? 201 : 200);
}

async function cancelWaiterCall(ctx: Ctx): Promise<Response> {
  const token = tableToken(ctx);
  const out = await ctx.deps.db.as({ role: 'public' }, async (tx) => {
    const t = await resolveTable(tx, token);
    const rows = await tx<{ id: string }>`
      UPDATE waiter_calls SET status = 'cancelada', resolved_at = now() WHERE table_id = ${t.table_id} AND status = 'aberta' RETURNING id`;
    return { restaurantId: t.restaurant_id, ids: rows.map((r) => r.id) };
  });
  for (const id of out.ids) ctx.deps.hub.publishRestaurant(out.restaurantId, { type: 'waiter.call.done', call_id: id, at: new Date().toISOString() });
  return json({ cancelled: out.ids.length });
}

// --- GET /api/public/menu/:token/orders (histórico da sessão da mesa) ----------------------------
async function getSessionOrders(ctx: Ctx): Promise<Response> {
  const token = tableToken(ctx);
  const orders = await ctx.deps.db.as({ role: 'public' }, async (tx) => {
    const t = await resolveTable(tx, token);
    const sessionId = await currentSessionId(tx, { restaurantId: t.restaurant_id, tableId: t.table_id }, ctx.deps.config.tableSessionMinutes);
    if (!sessionId) return [];
    await tx.setContext({ tableSessionId: sessionId });
    return listSessionOrders(tx, t.restaurant_id);
  });
  return json({ orders });
}

// --- POST /api/public/menu/:token/orders --------------------------------------------------------
interface PlaceResult {
  response: PlaceOrderResponse;
  event: { restaurantId: string; orderId: string; orderNumber: number; tableNumber: number } | null;
}

async function attemptPlaceOrder(deps: Deps, token: string, idempotencyKey: string, input: ReturnType<typeof CreateOrderInput.parse>): Promise<PlaceResult> {
  const publicCode = randomToken(16);
  const { limits } = deps.config;

  return deps.db.as({ role: 'public' }, async (tx): Promise<PlaceResult> => {
    const t = await resolveTable(tx, token);

    // 1) pedido repetido (mesma chave de idempotência): devolve o pedido já criado.
    // Primeiro põe-se em fila: um duplo toque que chegue ao mesmo tempo espera pelo primeiro envio e recebe o mesmo pedido,
    // em vez de ser avaliado pelos limites contra abuso como se fosse um pedido novo.
    await lockIdempotencyKey(tx, t.restaurant_id, idempotencyKey);
    const [replay] = await tx<{ code: string | null }>`SELECT lookup_idempotent_order(${idempotencyKey}) AS code`;
    if (replay?.code) {
      await tx.setContext({ publicCode: replay.code });
      const existing = await loadPublicOrder(tx, t.restaurant_id, replay.code);
      if (existing) return { response: { order: existing, replayed: true }, event: null };
    }

    // 2) o restaurante aceita pedidos?
    const [r] = await tx<{ service_fee_bps: number; accepting_orders: boolean; is_demo: boolean }>`
      SELECT service_fee_bps, accepting_orders, is_demo FROM restaurants WHERE id = ${t.restaurant_id}`;
    const [plan] = await tx<{ ok: boolean }>`SELECT restaurant_has_feature('orders') AS ok`;
    if (r?.is_demo) throw conflict('Este é um cardápio de demonstração: os pedidos não são enviados.', 'DEMO_RESTAURANT');
    if (!plan?.ok) throw new HttpError(403, 'PLAN_FEATURE', 'Este restaurante não recebe pedidos digitais. Peça a um empregado.');
    if (!r?.accepting_orders) {
      throw conflict('O restaurante não está a aceitar pedidos por QR Code neste momento. Peça a um empregado.', 'NOT_ACCEPTING_ORDERS');
    }

    // 3) proteção contra abuso nesta mesa. Os pedidos da mesma mesa passam um de cada vez, para que os limites sejam exatos
    // mesmo com muitos envios em paralelo. O tempo desde o último pedido usa o relógio real (clock_timestamp) e nunca fica negativo:
    // now() é a hora de início da transação, que pode ser anterior à de um pedido que entretanto foi gravado por outra transação.
    await lockTableOrdering(tx, t.table_id);
    const [stats] = await tx<{ pending: number; since_last: string | null }>`
      SELECT pending, EXTRACT(EPOCH FROM (clock_timestamp() - last_order_at))::text AS since_last FROM table_order_stats()`;
    if (stats && stats.pending >= limits.maxPendingOrdersPerTable) {
      throw tooMany('Esta mesa tem demasiados pedidos por atender. Aguarde ou chame um empregado.', 20, 'TOO_MANY_PENDING_ORDERS');
    }
    if (stats?.since_last !== null && stats?.since_last !== undefined && Math.max(0, Number(stats.since_last)) < limits.minSecondsBetweenOrders) {
      throw tooMany('Pedido enviado há instantes. Aguarde alguns segundos.', limits.minSecondsBetweenOrders, 'ORDERING_TOO_FAST');
    }

    // 4) preços calculados aqui, com os valores atuais da base de dados
    const priced = await priceOrder(tx, t.restaurant_id, input, r.service_fee_bps, limits);

    // 5) sessão da mesa e gravação (tudo na mesma transação)
    const sessionId = await ensureTableSession(tx, { restaurantId: t.restaurant_id, tableId: t.table_id }, deps.config.tableSessionMinutes);
    await tx.setContext({ publicCode, tableSessionId: sessionId });
    const { id } = await insertOrder(tx, {
      restaurantId: t.restaurant_id,
      tableId: t.table_id,
      tableSessionId: sessionId,
      publicCode,
      source: 'qr',
      createdBy: null,
      priced,
      notes: input.notes,
      idempotencyKey,
    });
    const order = await loadPublicOrder(tx, t.restaurant_id, publicCode);
    return {
      response: { order: order!, replayed: false },
      event: { restaurantId: t.restaurant_id, orderId: id, orderNumber: order!.order_number, tableNumber: t.table_number },
    };
  });
}

async function placeOrder(ctx: Ctx): Promise<Response> {
  const token = tableToken(ctx);
  const key = ctx.req.headers.get('idempotency-key') ?? '';
  if (!IDEMPOTENCY_RE.test(key)) {
    throw badRequest('Falta o cabeçalho Idempotency-Key (16 a 100 caracteres: letras, números, - e _).', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  const input = await ctx.body(CreateOrderInput);

  // limite por mesa, para além do limite por IP
  const lim = ctx.deps.limiter.hit(`pub-order-table:${token}`, 12, 60_000);
  if (!lim.ok) throw tooMany('Demasiados pedidos seguidos nesta mesa. Aguarde um momento.', lim.retryAfterSec);

  let result: PlaceResult;
  try {
    result = await attemptPlaceOrder(ctx.deps, token, key, input);
  } catch (err) {
    // dois envios simultâneos com a mesma chave: o segundo falha na restrição única; repetimos para devolver o primeiro
    if (pgCode(err) === '23505' && pgConstraint(err) === 'orders_idem_uq') result = await attemptPlaceOrder(ctx.deps, token, key, input);
    else throw err;
  }

  if (result.event) {
    const e = result.event;
    ctx.deps.hub.publishRestaurant(e.restaurantId, {
      type: 'order.created',
      order_id: e.orderId,
      order_number: e.orderNumber,
      table_number: e.tableNumber,
      at: new Date().toISOString(),
    });
  }
  return json(result.response, result.response.replayed ? 200 : 201);
}

// --- GET /api/public/orders/:code e /stream ------------------------------------------------------
async function withOrder<T>(ctx: Ctx, fn: (tx: Tx, restaurantId: string, code: string) => Promise<T>): Promise<T> {
  const code = orderCode(ctx);
  return ctx.deps.db.as({ role: 'public' }, async (tx) => {
    const [r] = await tx<{ restaurant_id: string }>`SELECT restaurant_id FROM resolve_order_code(${code})`;
    if (!r) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
    await tx.setContext({ restaurantId: r.restaurant_id, publicCode: code });
    return fn(tx, r.restaurant_id, code);
  });
}

async function getOrderByCode(ctx: Ctx): Promise<Response> {
  const order = await withOrder(ctx, (tx, rid, code) => loadPublicOrder(tx, rid, code));
  if (!order) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  return json({ order });
}

async function streamOrder(ctx: Ctx): Promise<Response> {
  const code = orderCode(ctx);
  const order = await withOrder(ctx, (tx, rid, c) => loadPublicOrder(tx, rid, c));
  if (!order) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  const release = ctx.deps.hub.acquireSlot(`sse:${ctx.ip}`, MAX_STREAMS_PER_IP);
  if (!release) throw tooMany('Demasiadas ligações em tempo real a partir desta rede.', 30, 'TOO_MANY_STREAMS');
  return sseResponse(ctx.req, {
    hello: { type: 'order.state', status: order.status as OrderStatus, at: new Date().toISOString() },
    subscribe: (send) => ctx.deps.hub.subscribeOrder(code, send),
    maxLifetimeMs: 25 * 60_000,
    onClose: release,
  });
}

export const publicRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/public/menu/:token', access: 'public', handler: getMenu, limits: [{ name: 'pub-menu', max: 600, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/public/restaurants/:slug', access: 'public', handler: getRestaurantMenu, limits: [{ name: 'pub-rest', max: 600, windowMs: 60_000 }] },
  { method: 'POST', path: '/api/public/menu/:token/call-waiter', access: 'public', handler: callWaiter, noBody: true, limits: [{ name: 'pub-call', max: 20, windowMs: 60_000 }] },
  { method: 'POST', path: '/api/public/menu/:token/call-waiter/cancel', access: 'public', handler: cancelWaiterCall, noBody: true, limits: [{ name: 'pub-call-cancel', max: 20, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/public/menu/:token/orders', access: 'public', handler: getSessionOrders, limits: [{ name: 'pub-session', max: 600, windowMs: 60_000 }] },
  { method: 'POST', path: '/api/public/menu/:token/orders', access: 'public', handler: placeOrder, limits: [{ name: 'pub-order', max: 40, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/public/orders/:code', access: 'public', handler: getOrderByCode, limits: [{ name: 'pub-order-get', max: 600, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/public/orders/:code/stream', access: 'public', handler: streamOrder, limits: [{ name: 'pub-stream', max: 120, windowMs: 60_000 }] },
];
