// Pedido registado pela equipa (cliente ao balcão, sem telemóvel, ou o empregado a anotar na mesa).
// Os preços são sempre calculados no servidor; os valores aqui são só uma estimativa para a equipa.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MenuItem, OrderView, StaffMenu, StaffTable } from '../../../../shared/types';
import { DishSheet } from '../../customer/DishSheet';
import { feeFor, feeLabel, lineTotal, toPayload, useCart, type CartLine } from '../../customer/cart';
import { errorText } from '../../lib/api';
import { useLive } from '../../lib/live';
import { randomKey } from '../../lib/format';
import { Button } from '../../ui/Button';
import { SelectField, Stepper, TextArea } from '../../ui/Fields';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { menu as menuApi, orders } from '../data';
import { useStaffStream } from '../hooks';
import { useRestaurant } from '../Shell';

interface Props {
  open: boolean;
  /** Mesa já escolhida (ex.: vindo do ecrã da mesa). */
  tableId: string | null;
  tables: StaffTable[];
  onClose: () => void;
  onCreated: (order: OrderView) => void;
}

/** O prato como o cliente o vê (só extras ativos). */
function toPublic(i: StaffMenu['categories'][number]['items'][number]): MenuItem {
  return {
    id: i.id,
    name: i.name,
    description: i.description,
    image_url: i.image_url,
    thumb_url: i.thumb_url,
    model_url: null,
    ingredients: i.ingredients,
    allergens: i.allergens,
    price_cents: i.price_cents,
    available: i.available,
    options: i.options.filter((o) => o.active).map((o) => ({ id: o.id, name: o.name, price_delta_cents: o.price_delta_cents, kind: o.kind })),
  };
}

export function ManualOrderSheet({ open, tableId, tables, onClose, onCreated }: Props) {
  const toast = useToast();
  const stream = useStaffStream();
  const { restaurant } = useRestaurant();
  const feeBps = restaurant?.service_fee_bps ?? 0;
  const cart = useCart('staff-manual', false);
  const live = useLive<StaffMenu>((signal) => menuApi.get(signal), { stream, enabled: open, pollMs: 30_000, safetyMs: 120_000 });

  const [table, setTable] = useState('');
  const [view, setView] = useState<'menu' | 'review'>('menu');
  const [query, setQuery] = useState('');
  const [dish, setDish] = useState<MenuItem | null>(null);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const { clear } = cart;

  // cada vez que a folha abre: começa limpa
  useLayoutEffect(() => {
    if (!open) return;
    clear();
    setTable(tableId ?? '');
    setView('menu');
    setQuery('');
    setNotes('');
    setError(null);
    setBusy(false);
    attempt.current = null;
    sending.current = false;
  }, [open, tableId, clear]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (live.data?.categories ?? [])
      .filter((c) => c.active)
      .map((c) => ({ ...c, items: c.items.filter((i) => i.active && (!q || i.name.toLowerCase().includes(q))).map(toPublic) }))
      .filter((c) => c.items.length > 0);
  }, [live.data, query]);

  const activeTables = useMemo(() => tables.filter((t) => t.active), [tables]);
  const current = tables.find((t) => t.id === table) ?? null;
  const fee = feeFor(cart.subtotal, feeBps);

  const send = async () => {
    if (sending.current) return;
    if (!table) {
      setError('Escolha a mesa.');
      setView('menu');
      return;
    }
    if (cart.lines.length === 0) {
      setError('Adicione pelo menos um prato.');
      return;
    }
    const body = { table_id: table, ...toPayload(cart.lines, notes) };
    // a mesma chave só se repete se o pedido for exatamente o mesmo (reenvio); se a pessoa o alterou, é outro pedido
    const sig = JSON.stringify(body);
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { sig, key: randomKey() };
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await orders.createManual(body, attempt.current.key);
      toast.show(`Pedido #${r.order.order_number} enviado para a cozinha (mesa ${r.order.table_number}).`);
      attempt.current = null;
      onCreated(r.order);
      onClose();
    } catch (err) {
      setError(errorText(err));
      live.refresh();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const title = view === 'review' ? 'Rever o pedido' : 'Novo pedido';
  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        locked={busy}
        wide
        title={current ? `${title} · Mesa ${current.table_number}` : title}
        footer={
          view === 'menu' ? (
            <Button size="big" block split disabled={cart.lines.length === 0} onClick={() => setView('review')}>
              <span>Rever pedido ({cart.units})</span>
              <Money cents={cart.subtotal} />
            </Button>
          ) : (
            <div className="stack-sm">
              <Button size="big" block split loading={busy} onClick={() => void send()}>
                <span>Enviar para a cozinha</span>
                <Money cents={cart.subtotal + fee} />
              </Button>
              <Button variant="quiet" block disabled={busy} onClick={() => setView('menu')}>
                Voltar ao menu
              </Button>
            </div>
          )
        }
      >
        <div className="stack">
          {error ? (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          ) : null}

          {view === 'menu' ? (
            <>
              <SelectField label="Mesa" value={table} onChange={(e) => setTable(e.target.value)}>
                <option value="">Escolha a mesa…</option>
                {activeTables.map((t) => (
                  <option key={t.id} value={t.id}>
                    Mesa {t.table_number}
                    {t.label ? ` · ${t.label}` : ''}
                  </option>
                ))}
              </SelectField>
              <div className="field">
                <label className="label" htmlFor="manual-search">
                  Procurar prato
                </label>
                <input id="manual-search" className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" placeholder="Ex.: muamba" />
              </div>
              {live.loading ? <p className="muted">A carregar o menu…</p> : null}
              {live.error && !live.data ? (
                <div className="notice notice-danger" role="alert">
                  {live.error.message}
                </div>
              ) : null}
              {groups.map((c) => (
                <section key={c.id} className="stack-sm" aria-label={c.name}>
                  <h3 className="section-title">{c.name}</h3>
                  <ul className="pick-list">
                    {c.items.map((i) => {
                      const inCart = cart.lines.filter((l) => l.itemId === i.id).reduce((n, l) => n + l.quantity, 0);
                      return (
                        <li key={i.id}>
                          <button type="button" className="pick-row" disabled={!i.available} onClick={() => { setEditing(null); setDish(i); }}>
                            <span className="pick-main">
                              <span className="pick-name">{i.name}</span>
                              {!i.available ? <span className="pick-out">Esgotado</span> : null}
                              {i.options.length > 0 && i.available ? <span className="muted small">Com extras</span> : null}
                            </span>
                            <span className="pick-side">
                              {inCart > 0 ? <span className="pick-qty num">{inCart}×</span> : null}
                              <Money className="muted" cents={i.price_cents} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
              {live.data && groups.length === 0 ? <p className="muted">Nenhum prato encontrado.</p> : null}
            </>
          ) : (
            <>
              <p className="muted">
                Mesa {current?.table_number}
                {current?.label ? ` · ${current.label}` : ''}. Confirme o pedido com o cliente antes de enviar.
              </p>
              <ul className="review-list">
                {cart.lines.map((l) => (
                  <li key={l.key} className="review-line">
                    <div className="grow">
                      <p>
                        <strong>{l.name}</strong>
                      </p>
                      {l.options.length > 0 ? <p className="muted small">{l.options.map((o) => `+ ${o.name}`).join(' · ')}</p> : null}
                      {l.notes ? (
                        <p>
                          <span className="marker">{l.notes}</span>
                        </p>
                      ) : null}
                      <div className="review-actions">
                        <Stepper value={l.quantity} min={0} max={20} label={l.name} onChange={(v) => cart.setQuantity(l.key, v)} small />
                        <Button variant="quiet" size="sm" onClick={() => { setEditing(l); setDish({ id: l.itemId, name: l.name, description: null, image_url: null, thumb_url: null, model_url: null, ingredients: [], allergens: [], price_cents: l.unitCents, available: true, options: [] }); }}>
                          Alterar
                        </Button>
                      </div>
                    </div>
                    <Money cents={lineTotal(l)} />
                  </li>
                ))}
              </ul>
              <TextArea label="Nota para a cozinha (opcional)" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} hint="Por exemplo: alergias ou pressa." />
              <div className="totals">
                <div className="leader">
                  <span className="lead muted">Subtotal</span>
                  <span className="fill" aria-hidden="true" />
                  <Money className="tail" cents={cart.subtotal} />
                </div>
                {feeBps > 0 ? (
                  <div className="leader">
                    <span className="lead muted">Taxa de serviço ({feeLabel(feeBps)})</span>
                    <span className="fill" aria-hidden="true" />
                    <Money className="tail" cents={fee} />
                  </div>
                ) : null}
                <div className="leader total-row">
                  <span className="lead">Total estimado</span>
                  <span className="fill" aria-hidden="true" />
                  <Money className="tail" cents={cart.subtotal + fee} />
                </div>
              </div>
              <p className="muted small">O valor final é calculado pelo sistema com os preços do menu.</p>
            </>
          )}
        </div>
      </Sheet>

      <ItemPicker
        item={dish}
        editing={editing}
        menu={live.data}
        onClose={() => {
          setDish(null);
          setEditing(null);
        }}
        onSubmit={(line, replacingKey) => {
          if (replacingKey) cart.replace(replacingKey, line);
          else cart.add(line);
          setDish(null);
          setEditing(null);
          if (replacingKey) setView('review');
        }}
      />
    </>
  );
}

/** Escolha dos extras de um prato: ao alterar uma linha do pedido, usa os dados completos do menu. */
function ItemPicker({
  item,
  editing,
  menu,
  onClose,
  onSubmit,
}: {
  item: MenuItem | null;
  editing: CartLine | null;
  menu: StaffMenu | undefined;
  onClose: () => void;
  onSubmit: (line: Omit<CartLine, 'key'>, replacingKey: string | null) => void;
}) {
  const full = useMemo(() => {
    if (!item) return null;
    if (!editing) return item;
    const found = menu?.categories.flatMap((c) => c.items).find((i) => i.id === item.id);
    return found ? toPublic(found) : item;
  }, [item, editing, menu]);
  return <DishSheet item={full} initial={editing} canAdd model3d={false} ar={false} restaurantName="" onClose={onClose} onSubmit={onSubmit} />;
}
