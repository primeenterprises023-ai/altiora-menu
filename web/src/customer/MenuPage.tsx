// Cardápio digital do cliente (ALTIORA MENU). Dois endereços, a mesma página:
//   /menu/<código da mesa>  QR Code da mesa: pedido pelo sistema, «Chamar o garçom», acompanhamento;
//   /r/<restaurante>        página do restaurante (sem mesa): ver o menu e, se o plano o incluir, pedir por WhatsApp.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { openingStatus } from '../../../shared/hours';
import { ALLERGENS } from '../../../shared/allergens';
import type { MenuItem, PublicMenu } from '../../../shared/types';
import { ApiError } from '../lib/api';
import { kz, setCurrency } from '../lib/format';
import { useLive } from '../lib/live';
import { Link, navigate, useLocation } from '../lib/router';
import { local } from '../lib/storage';
import { applyAccent, applyRestaurantTheme } from '../lib/theme';
import { Button } from '../ui/Button';
import { Money } from '../ui/Money';
import { Sheet } from '../ui/Sheet';
import { ErrorState, Loading } from '../ui/States';
import { useToast } from '../ui/Toast';
import { CartSheet } from './CartSheet';
import { DishSheet } from './DishSheet';
import { InfoSheet } from './InfoSheet';
import { WaiterCall } from './WaiterCall';
import { LAST_MENU_KEY, publicApi, restaurantApi } from './data';
import { CloseIcon, CubeIcon, InfoIcon, PlusIcon, SearchIcon, SlidersIcon } from './icons';
import { MAX_LINE_QUANTITY, cartAvailable, cartSubtotal, feeFor, feeLabel, reconcileCart, useCart, type CartLine } from './cart';
import { countItems, filterMenu } from './search';

type Source = { kind: 'table'; token: string } | { kind: 'slug'; slug: string };

const tableTitle = (t: { number: number; label: string | null }) => `Mesa ${t.number}${t.label ? `, ${t.label}` : ''}`;

function menuProblem(err: ApiError): { title: string; text: string } | null {
  switch (err.code) {
    case 'TABLE_NOT_FOUND':
      return { title: 'QR Code inválido', text: 'Este QR Code não é válido ou foi desativado. Peça ajuda a um empregado.' };
    case 'RESTAURANT_NOT_FOUND':
      return { title: 'Restaurante não encontrado', text: 'Este endereço não existe. Confirme o endereço ou leia outra vez o QR Code.' };
    case 'RESTAURANT_UNAVAILABLE':
    case 'TABLE_UNAVAILABLE':
      return { title: 'Menu indisponível', text: err.message };
    default:
      return null;
  }
}

export function MenuPage({ token }: { token: string }) {
  return <MenuView source={{ kind: 'table', token }} />;
}
export function RestaurantPage({ slug }: { slug: string }) {
  return <MenuView source={{ kind: 'slug', slug }} />;
}

function MenuView({ source }: { source: Source }) {
  const toast = useToast();
  const loc = useLocation();
  const embed = loc.params.get('embed') === '1';
  const key = source.kind === 'table' ? source.token : `r:${source.slug}`;
  const menu = useLive<PublicMenu>((signal) => (source.kind === 'table' ? publicApi.menu(source.token, signal) : restaurantApi.menu(source.slug, signal)), {
    pollMs: 40_000,
    safetyMs: 40_000,
    resetKey: key,
  });
  const history = useLive((signal) => publicApi.sessionOrders(source.kind === 'table' ? source.token : '', signal), {
    pollMs: 30_000,
    safetyMs: 30_000,
    resetKey: key,
    enabled: source.kind === 'table' && !!menu.data,
  });
  const cart = useCart(key);
  const [cartOpen, setCartOpen] = useState(false);
  const [dish, setDish] = useState<MenuItem | null>(null);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [infoOpen, setInfoOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const data = menu.data;
  if (data) setCurrency(data.restaurant.currency);
  const itemsById = useMemo(() => {
    const m = new Map<string, MenuItem>();
    for (const c of data?.categories ?? []) for (const i of c.items) m.set(i.id, i);
    return m;
  }, [data]);

  // identidade do restaurante: cor, tema, título da página e memória do endereço (para "Voltar ao menu")
  useEffect(() => {
    if (!data) return;
    applyAccent(data.restaurant.accent_color);
    document.title = `${data.restaurant.name} — Cardápio digital`;
    if (!embed) local.set(LAST_MENU_KEY, source.kind === 'table' ? `/menu/${source.token}` : `/r/${source.slug}`);
    return applyRestaurantTheme(data.restaurant.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.restaurant.accent_color, data?.restaurant.theme, data?.restaurant.name, key]);

  // o menu pode mudar enquanto a pessoa escolhe (prato esgotado, preço novo): ajusta o pedido e avisa
  useEffect(() => {
    if (!data) return;
    const r = reconcileCart(cart.linesRef.current, data);
    if (r.changed) {
      cart.replaceAll(r.lines);
      if (r.notices.length > 0) {
        setNotices((cur) => [...new Set([...cur, ...r.notices])]);
        if (!cartOpen) toast.show('O menu foi atualizado. Verifique o seu pedido.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (cart.lines.length === 0) setNotices([]);
  }, [cart.lines.length]);

  const caps = data?.capabilities;
  const cartEnabled = !!data && cartAvailable(data);
  const showBar = cartEnabled && cart.units > 0;
  useEffect(() => {
    document.body.classList.toggle('has-cart-bar', showBar);
    return () => document.body.classList.remove('has-cart-bar');
  }, [showBar]);

  const categories = data?.categories ?? [];
  const visible = useMemo(() => filterMenu(categories, { query, category, excluded }), [categories, query, category, excluded]);
  const quantityOf = useCallback((itemId: string) => cart.lines.filter((l) => l.itemId === itemId).reduce((n, l) => n + l.quantity, 0), [cart.lines]);

  const status = useMemo(() => (data ? openingStatus(data.restaurant.opening_hours, data.restaurant.timezone) : null), [data]);

  if (menu.loading) {
    return (
      <div className="mn">
        <div className="mn-hero mn-hero-loading" />
        <div className="mn-body">
          <Loading rows={9} label="A carregar o cardápio…" />
        </div>
      </div>
    );
  }
  if (!data || !caps) {
    const err = menu.error;
    const known = err ? menuProblem(err) : null;
    return (
      <div className="mn">
        {known ? (
          <div className="state">
            <h2>{known.title}</h2>
            <p>{known.text}</p>
          </div>
        ) : (
          <ErrorState error={err} onRetry={menu.refresh} />
        )}
      </div>
    );
  }

  const { restaurant, accepting_orders: accepting, table } = data;
  const subtotal = cartSubtotal(cart.lines);
  const total = subtotal + feeFor(subtotal, restaurant.service_fee_bps);
  const sessionOrders = history.data?.orders.length ?? 0;
  const canOrder = caps.orders && !restaurant.is_demo;
  const filtering = query.trim() !== '' || category !== null || excluded.size > 0;
  const shown = countItems(visible);
  const tableName = table ? tableTitle(table) : null;

  const quickAdd = (item: MenuItem) => cart.add({ itemId: item.id, name: item.name, unitCents: item.price_cents, quantity: 1, notes: '', options: [] });
  const quickRemove = (item: MenuItem) => {
    const line = cart.lines.find((l) => l.itemId === item.id && l.options.length === 0 && !l.notes);
    if (line) cart.setQuantity(line.key, line.quantity - 1);
  };
  const clearFilters = () => {
    setQuery('');
    setCategory(null);
    setExcluded(new Set());
  };
  const toggleAllergen = (code: string) =>
    setExcluded((cur) => {
      const next = new Set(cur);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  return (
    <div className={`mn${restaurant.font === 'sans' ? ' mn-sans' : ''}${embed ? ' mn-embed' : ''}`}>
      <header className="mn-hero">
        {restaurant.cover_url ? <img className="mn-cover" src={restaurant.cover_url} alt="" decoding="async" fetchPriority="high" /> : <div className="mn-cover mn-cover-plain" aria-hidden="true" />}
        <div className="mn-hero-inner">
          <div className="mn-id">
            {restaurant.logo_url ? (
              <img className="mn-logo" src={restaurant.logo_url} alt={`Logótipo de ${restaurant.name}`} decoding="async" />
            ) : (
              <span className="mn-logo mn-logo-fallback voice" aria-hidden="true">
                {restaurant.name.trim().charAt(0).toUpperCase()}
              </span>
            )}
            <div className="mn-id-text">
              <p className="mn-eyebrow">{tableName ?? 'Cardápio digital'}</p>
              <h1 className="mn-name voice">{restaurant.name}</h1>
            </div>
          </div>
          {restaurant.description ? <p className="mn-desc">{restaurant.description}</p> : null}
          <div className="mn-meta">
            {status && status.open !== null ? (
              <span className={`mn-status ${status.open ? 'mn-status-open' : 'mn-status-closed'}`}>
                <span className="mn-dot" aria-hidden="true" />
                {status.label}
              </span>
            ) : null}
            <button type="button" className="mn-link" onClick={() => setInfoOpen(true)}>
              <InfoIcon /> Horário e contactos
            </button>
            {sessionOrders > 0 && source.kind === 'table' ? (
              <Link className="mn-link" to={`/menu/${source.token}/pedidos`}>
                Os meus pedidos ({sessionOrders})
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mn-sticky">
        <div className="mn-tools">
          <label className="mn-search">
            <SearchIcon />
            <span className="sr-only">Pesquisar no cardápio</span>
            <input type="search" inputMode="search" enterKeyHint="search" autoComplete="off" placeholder="Pesquisar pratos e ingredientes" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={60} />
            {query ? (
              <button type="button" className="mn-clear" onClick={() => setQuery('')} aria-label="Limpar a pesquisa">
                <CloseIcon />
              </button>
            ) : null}
          </label>
          <button type="button" className={`mn-filter${excluded.size > 0 ? ' mn-filter-on' : ''}`} onClick={() => setFiltersOpen(true)} aria-label={excluded.size > 0 ? `Filtros de alergénios (${excluded.size})` : 'Filtros de alergénios'}>
            <SlidersIcon />
            {excluded.size > 0 ? <span className="mn-filter-count">{excluded.size}</span> : null}
          </button>
        </div>
        {categories.length > 1 ? (
          <nav className="mn-chips" aria-label="Categorias do cardápio">
            <button type="button" className="mn-chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
              Todos
            </button>
            {categories.map((c) => (
              <button key={c.id} type="button" className="mn-chip" aria-pressed={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
                {c.name}
              </button>
            ))}
          </nav>
        ) : null}
      </div>

      <main className="mn-body">
        {menu.error ? (
          <p className="notice notice-danger" role="status">
            Sem ligação. O cardápio mostrado pode estar desatualizado.
          </p>
        ) : null}
        {table && !accepting && caps.orders ? (
          <p className="notice notice-danger" role="status">
            <strong>O restaurante não está a receber pedidos por QR Code neste momento.</strong> Pode ver o cardápio; para pedir, {caps.whatsapp ? 'use o WhatsApp do restaurante ou ' : ''}fale com um empregado.
          </p>
        ) : null}
        {restaurant.is_demo ? (
          <p className="notice" role="status">
            <strong>Cardápio de demonstração</strong> com pratos fictícios. As imagens são geradas por computador e os preços são apenas exemplos.
          </p>
        ) : null}

        {categories.length === 0 ? (
          <div className="state">
            <h2>O cardápio ainda está vazio</h2>
            <p>O restaurante ainda não publicou os pratos.</p>
          </div>
        ) : null}

        {categories.length > 0 && filtering ? (
          <p className="mn-count" role="status" aria-live="polite">
            {shown === 0 ? 'Nenhum prato encontrado.' : `${shown} ${shown === 1 ? 'prato' : 'pratos'}`}{' '}
            <button type="button" className="mn-linkbtn" onClick={clearFilters}>
              Limpar filtros
            </button>
          </p>
        ) : null}

        {visible.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="mn-cat" aria-labelledby={`h-${c.id}`}>
            <h2 id={`h-${c.id}`} className="mn-cat-title voice">
              {c.name}
            </h2>
            <ul className={`mn-grid${cartEnabled ? ' mn-grid-cart' : ''}`}>
              {c.items.map((item) => {
                const qty = quantityOf(item.id);
                const needsChoice = item.options.length > 0;
                const unavailable = !item.available;
                const hasSize = item.options.some((o) => o.kind === 'size');
                const thumb = item.thumb_url ?? item.image_url;
                return (
                  <li key={item.id} className={`mn-card${unavailable ? ' mn-card-off' : ''}${qty > 0 ? ' mn-card-in' : ''}`}>
                    <button type="button" className="mn-card-open" onClick={() => setDish(item)} aria-label={`${item.name}, ${hasSize ? 'a partir de ' : ''}${kz(item.price_cents)}${unavailable ? ', esgotado' : ''}. Ver detalhes`}>
                      <span className={`mn-media${thumb ? '' : ' mn-media-empty'}`}>
                        {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" width="480" height="360" /> : <span className="voice" aria-hidden="true">{item.name.charAt(0)}</span>}
                        {caps.model_3d && item.model_url ? (
                          <span className="mn-badge3d">
                            <CubeIcon /> 3D
                          </span>
                        ) : null}
                        {unavailable ? <span className="mn-soldout">Esgotado</span> : null}
                      </span>
                      <span className="mn-card-text">
                        <span className="mn-card-name voice">{item.name}</span>
                        {item.description ? <span className="mn-card-desc">{item.description}</span> : null}
                        <span className="mn-card-price num">
                          {hasSize ? <small>a partir de </small> : null}
                          {kz(item.price_cents)}
                        </span>
                      </span>
                    </button>
                    {cartEnabled && !unavailable ? (
                      !needsChoice && qty > 0 ? (
                        <div className="stepper mn-step" role="group" aria-label={`Quantidade de ${item.name}`}>
                          <button type="button" onClick={() => quickRemove(item)} aria-label={`Diminuir ${item.name}`}>
                            −
                          </button>
                          <output aria-live="polite">{qty}</output>
                          <button type="button" onClick={() => quickAdd(item)} disabled={qty >= MAX_LINE_QUANTITY} aria-label={`Aumentar ${item.name}`}>
                            +
                          </button>
                        </div>
                      ) : (
                        <button type="button" className="mn-add" onClick={() => (needsChoice ? setDish(item) : quickAdd(item))} aria-label={`Adicionar ${item.name}`}>
                          {needsChoice && qty > 0 ? <span className="mn-add-count">{qty}</span> : <PlusIcon />}
                        </button>
                      )
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        <footer className="mn-foot">
          {restaurant.service_fee_bps > 0 && canOrder ? <p>Os pedidos têm uma taxa de serviço de {feeLabel(restaurant.service_fee_bps)}, mostrada antes de enviar.</p> : null}
          <p>Tem alguma alergia ou intolerância? Diga-o à equipa antes de pedir.</p>
          {restaurant.show_brand ? (
            <p className="mn-brand">
              <span className="mn-brand-mark" aria-hidden="true" />
              <a href="/" target={embed ? '_top' : undefined}>
                ALTIORA MENU
              </a>
              <span> · Digital Dining Experience</span>
            </p>
          ) : null}
        </footer>
      </main>

      {caps.waiter_call && table && source.kind === 'table' ? (
        <WaiterCall token={source.token} tableName={tableName!} call={data.waiter_call} timezone={restaurant.timezone} onChanged={menu.refresh} />
      ) : null}

      {showBar ? (
        <div className="cart-bar-wrap">
          <Button size="big" block split className="cart-bar" onClick={() => setCartOpen(true)}>
            <span>
              Ver pedido <span className="cart-bar-count">{cart.units}</span>
            </span>
            <Money cents={total} />
          </Button>
        </div>
      ) : null}

      <InfoSheet open={infoOpen} onClose={() => setInfoOpen(false)} restaurant={restaurant} />

      <Sheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Evitar alergénios"
        footer={
          <div className="row-wrap">
            <Button variant="quiet" onClick={() => setExcluded(new Set())} disabled={excluded.size === 0}>
              Limpar
            </Button>
            <Button onClick={() => setFiltersOpen(false)}>Ver pratos</Button>
          </div>
        }
      >
        <div className="stack">
          <p className="muted">Escolha o que quer evitar: os pratos que o contêm deixam de aparecer. Só aparecem os alergénios que o restaurante declarou; em caso de dúvida, pergunte à equipa.</p>
          <fieldset className="extras">
            <legend className="sr-only">Alergénios a evitar</legend>
            {ALLERGENS.map((a) => (
              <label key={a.code} className="check-row">
                <input type="checkbox" checked={excluded.has(a.code)} onChange={() => toggleAllergen(a.code)} />
                <span className="check-label">{a.label}</span>
              </label>
            ))}
          </fieldset>
        </div>
      </Sheet>

      <DishSheet
        item={dish}
        initial={editing}
        canAdd={cartEnabled}
        model3d={caps.model_3d}
        ar={caps.ar}
        restaurantName={restaurant.name}
        onClose={() => {
          setDish(null);
          setEditing(null);
        }}
        onSubmit={(line, replacingKey) => {
          if (replacingKey) cart.replace(replacingKey, line);
          else cart.add(line);
          setDish(null);
          setEditing(null);
          toast.show(`${line.name} adicionado ao pedido.`);
        }}
      />

      <CartSheet
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        token={source.kind === 'table' ? source.token : ''}
        tableName={tableName}
        restaurantName={restaurant.name}
        feeBps={restaurant.service_fee_bps}
        acceptingOrders={accepting}
        canOrder={canOrder && source.kind === 'table'}
        demo={restaurant.is_demo}
        whatsapp={caps.whatsapp ? restaurant.whatsapp : null}
        lines={cart.lines}
        notices={notices}
        onQuantity={cart.setQuantity}
        onRemove={cart.remove}
        onEdit={(l) => {
          const item = itemsById.get(l.itemId);
          if (!item) return;
          setCartOpen(false);
          setEditing(l);
          setDish(item);
        }}
        onMenuStale={menu.refresh}
        onPlaced={(order) => {
          cart.clear();
          toast.clear();
          setNotices([]);
          setCartOpen(false);
          history.refresh();
          navigate(`/pedido/${order.public_code}`);
        }}
      />
    </div>
  );
}

