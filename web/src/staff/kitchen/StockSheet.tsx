import { useMemo, useState } from 'react';
import type { StaffMenu } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import type { LiveState } from '../../lib/live';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { Switch } from '../../ui/Fields';
import { useToast } from '../../ui/Toast';
import { menu as menuApi } from '../data';

interface Props {
  open: boolean;
  onClose: () => void;
  live: LiveState<StaffMenu>;
}

/** Marcar pratos como esgotados (ou outra vez disponíveis). Os clientes deixam de os poder pedir de imediato. */
export function StockSheet({ open, onClose, live }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const menu = live.data;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (menu?.categories ?? [])
      .filter((c) => c.active)
      .map((c) => ({ ...c, items: c.items.filter((i) => i.active && (!q || i.name.toLowerCase().includes(q))) }))
      .filter((c) => c.items.length > 0);
  }, [menu, query]);

  const soldOut = useMemo(() => groups.flatMap((c) => c.items).filter((i) => !i.available), [groups]);

  const toggle = async (id: string, available: boolean) => {
    if (pending.has(id)) return;
    setPending((p) => new Set(p).add(id));
    live.mutate((cur) =>
      cur ? { categories: cur.categories.map((c) => ({ ...c, items: c.items.map((i) => (i.id === id ? { ...i, available } : i)) })) } : cur,
    );
    try {
      await menuApi.setAvailability(id, available);
    } catch (err) {
      toast.show(errorText(err), 'danger');
      live.refresh();
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  };

  return (
    <Sheet open={open} onClose={onClose} wide title="Pratos esgotados">
      <div className="stack">
        <p className="muted">Desligue um prato quando acabar. Os clientes deixam de o poder pedir logo a seguir.</p>
        <div className="field">
          <label className="label" htmlFor="stock-search">
            Procurar prato
          </label>
          <input id="stock-search" className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ex.: muamba" autoComplete="off" />
        </div>
        {live.loading ? <p className="muted">A carregar…</p> : null}
        {live.error && !menu ? (
          <div className="notice notice-danger" role="alert">
            {live.error.message}
          </div>
        ) : null}

        {soldOut.length > 0 ? (
          <section className="stack-sm" aria-label="Esgotados neste momento">
            <h3 className="section-title">Esgotados neste momento ({soldOut.length})</h3>
            <ul className="stock-list">
              {soldOut.map((i) => (
                <li key={i.id} className="stock-row is-out">
                  <Switch checked={i.available} disabled={pending.has(i.id)} onChange={(v) => void toggle(i.id, v)} label={<span className="stock-name">{i.name}</span>} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {groups.map((c) => (
          <section key={c.id} className="stack-sm" aria-label={c.name}>
            <h3 className="section-title">{c.name}</h3>
            <ul className="stock-list">
              {c.items.map((i) => (
                <li key={i.id} className={`stock-row${i.available ? '' : ' is-out'}`}>
                  <Switch checked={i.available} disabled={pending.has(i.id)} onChange={(v) => void toggle(i.id, v)} label={<span className="stock-name">{i.name}</span>} />
                  <Money className="muted small" cents={i.price_cents} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {menu && groups.length === 0 ? <p className="muted">Nenhum prato encontrado.</p> : null}
      </div>
    </Sheet>
  );
}
