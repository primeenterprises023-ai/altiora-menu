// Menu do gerente: categorias, pratos, extras, disponibilidade e ordem.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { StaffMenu, StaffMenuCategory, StaffMenuItem } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { useLive } from '../../lib/live';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Fields';
import { Money } from '../../ui/Money';
import { ConnectionPill } from '../../ui/Pill';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { menu as menuApi } from '../data';
import { plain, reorderUpdates } from '../forms';
import { useDocumentTitle, useStaffStream } from '../hooks';
import { CategorySheet } from './CategorySheet';
import { ItemSheet } from './ItemSheet';

export default function MenuAdminPage() {
  const toast = useToast();
  const stream = useStaffStream();
  const live = useLive<StaffMenu>((signal) => menuApi.get(signal), { stream, pollMs: 30_000, safetyMs: 120_000 });
  const { refresh, mutate } = live;
  const [itemSheet, setItemSheet] = useState<{ itemId: string | null; categoryId?: string } | null>(null);
  const [catSheet, setCatSheet] = useState<{ categoryId: string | null } | null>(null);
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState(false);
  const toggling = useRef(new Set<string>());
  useDocumentTitle('Menu');

  const categories = live.data?.categories ?? [];
  const searching = query.trim().length > 0;
  const needle = plain(query.trim());
  const shown = useMemo(
    () =>
      categories
        .map((c) => ({ ...c, visible: searching ? c.items.filter((i) => plain(i.name).includes(needle) || plain(i.description ?? '').includes(needle)) : c.items }))
        .filter((c) => !searching || c.visible.length > 0),
    [categories, searching, needle],
  );

  const applyOrders = useCallback(
    (kind: 'categories' | 'items', categoryId: string | null, updates: Array<{ id: string; display_order: number }>) => {
      const order = new Map(updates.map((u) => [u.id, u.display_order]));
      const sortBy = <T extends { display_order: number; name: string }>(list: T[]) =>
        [...list].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name, 'pt'));
      mutate((cur) => {
        if (!cur) return cur;
        if (kind === 'categories') {
          return { categories: sortBy(cur.categories.map((c) => (order.has(c.id) ? { ...c, display_order: order.get(c.id)! } : c))) };
        }
        return {
          categories: cur.categories.map((c) =>
            c.id === categoryId ? { ...c, items: sortBy(c.items.map((i) => (order.has(i.id) ? { ...i, display_order: order.get(i.id)! } : i))) } : c,
          ),
        };
      });
    },
    [mutate],
  );

  const move = async (kind: 'categories' | 'items', categoryId: string | null, list: Array<{ id: string; display_order: number }>, index: number, dir: -1 | 1) => {
    if (moving) return;
    const updates = reorderUpdates(list, index, dir);
    if (updates.length === 0) return;
    setMoving(true);
    applyOrders(kind, categoryId, updates);
    try {
      await Promise.all(updates.map((u) => (kind === 'categories' ? menuApi.updateCategory(u.id, { display_order: u.display_order }) : menuApi.updateItem(u.id, { display_order: u.display_order }))));
    } catch (err) {
      toast.show(errorText(err), 'danger');
    } finally {
      setMoving(false);
      refresh();
    }
  };

  const setAvailable = async (item: StaffMenuItem, available: boolean) => {
    if (toggling.current.has(item.id)) return;
    toggling.current.add(item.id);
    mutate((cur) => (cur ? { categories: cur.categories.map((c) => ({ ...c, items: c.items.map((i) => (i.id === item.id ? { ...i, available } : i)) })) } : cur));
    try {
      await menuApi.setAvailability(item.id, available);
    } catch (err) {
      toast.show(errorText(err), 'danger');
      refresh();
    } finally {
      toggling.current.delete(item.id);
    }
  };

  const onSaved = (item: StaffMenuItem, created: boolean) => {
    mutate((cur) => {
      if (!cur) return cur;
      const without = cur.categories.map((c) => ({ ...c, items: c.items.filter((i) => i.id !== item.id) }));
      return { categories: without.map((c) => (c.id === item.category_id ? { ...c, items: [...c.items, item].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name, 'pt')) } : c)) };
    });
    if (created) setItemSheet({ itemId: item.id });
    refresh();
  };

  const newItem = (categoryId?: string) => setItemSheet({ itemId: null, categoryId });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Menu</h1>
          <ConnectionPill live={live.live} error={live.error} />
        </div>
        <div className="toolbar">
          <Button variant="secondary" onClick={() => setCatSheet({ categoryId: null })}>
            Nova categoria
          </Button>
          <Button disabled={categories.length === 0} onClick={() => newItem(categories[0]?.id)}>
            Novo prato
          </Button>
        </div>
      </div>

      <StaleNotice error={live.data ? live.error : null} />

      {live.loading ? (
        <Loading rows={6} />
      ) : live.error && !live.data ? (
        <ErrorState error={live.error} onRetry={refresh} />
      ) : categories.length === 0 ? (
        <EmptyState title="O menu ainda está vazio.">
          Comece por criar uma categoria (por exemplo, "Entradas") e depois junte-lhe pratos.
          <br />
          <Button className="mt" onClick={() => setCatSheet({ categoryId: null })}>
            Criar a primeira categoria
          </Button>
        </EmptyState>
      ) : (
        <>
          <div className="field search-field">
            <label className="label" htmlFor="menu-search">
              Procurar prato
            </label>
            <input id="menu-search" className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" placeholder="Nome ou descrição" />
          </div>

          {shown.length === 0 ? <EmptyState title="Nenhum prato encontrado.">Experimente outras palavras.</EmptyState> : null}

          <div className="stack-lg">
            {shown.map((c, ci) => (
              <CategoryBlock
                key={c.id}
                category={c}
                visible={c.visible}
                first={ci === 0}
                last={ci === shown.length - 1}
                canMove={!searching && !moving}
                onMoveCategory={(dir) => void move('categories', null, categories, categories.findIndex((x) => x.id === c.id), dir)}
                onMoveItem={(itemId, dir) => void move('items', c.id, c.items, c.items.findIndex((x) => x.id === itemId), dir)}
                onEditCategory={() => setCatSheet({ categoryId: c.id })}
                onNewItem={() => newItem(c.id)}
                onEditItem={(id) => setItemSheet({ itemId: id })}
                onAvailable={(item, v) => void setAvailable(item, v)}
              />
            ))}
          </div>
        </>
      )}

      <ItemSheet state={itemSheet} menu={live.data} onClose={() => setItemSheet(null)} onSaved={onSaved} onChanged={refresh} />
      <CategorySheet state={catSheet} menu={live.data} onClose={() => setCatSheet(null)} onChanged={refresh} />
    </div>
  );
}

interface BlockProps {
  category: StaffMenuCategory;
  visible: StaffMenuItem[];
  first: boolean;
  last: boolean;
  canMove: boolean;
  onMoveCategory: (dir: -1 | 1) => void;
  onMoveItem: (itemId: string, dir: -1 | 1) => void;
  onEditCategory: () => void;
  onNewItem: () => void;
  onEditItem: (id: string) => void;
  onAvailable: (item: StaffMenuItem, available: boolean) => void;
}

function CategoryBlock({ category: c, visible, first, last, canMove, onMoveCategory, onMoveItem, onEditCategory, onNewItem, onEditItem, onAvailable }: BlockProps) {
  return (
    <section className="adm-cat" aria-label={c.name}>
      <header className="adm-cat-head">
        <div className="adm-cat-title">
          <h2 className="voice">{c.name}</h2>
          {!c.active ? <Badge>Escondida</Badge> : null}
        </div>
        <div className="adm-cat-actions">
          <Button size="sm" variant="secondary" aria-label={`Editar a categoria ${c.name}`} onClick={onEditCategory}>
            Editar
          </Button>
          <Button size="sm" aria-label={`Novo prato em ${c.name}`} onClick={onNewItem}>
            Novo prato
          </Button>
          {canMove ? (
            <span className="move-btns">
              <Button size="sm" variant="quiet" aria-label={`Subir a categoria ${c.name}`} disabled={first} onClick={() => onMoveCategory(-1)}>
                ↑
              </Button>
              <Button size="sm" variant="quiet" aria-label={`Descer a categoria ${c.name}`} disabled={last} onClick={() => onMoveCategory(1)}>
                ↓
              </Button>
            </span>
          ) : null}
        </div>
      </header>
      {visible.length === 0 ? (
        <p className="muted small">Ainda não há pratos nesta categoria.</p>
      ) : (
        <ul className="adm-items">
          {visible.map((i, ii) => (
            <li key={i.id} className={`adm-row${i.active ? '' : ' is-hidden'}`}>
              <button type="button" className="adm-row-main" onClick={() => onEditItem(i.id)} aria-label={`Abrir ${i.name}`}>
                <span className="adm-row-top">
                  <span className="adm-row-name">{i.name}</span>
                  <Money cents={i.price_cents} />
                </span>
                {i.description ? <span className="adm-row-desc muted small">{i.description}</span> : null}
                <span className="adm-row-tags">
                  {!i.available ? <Badge tone="danger">Esgotado</Badge> : null}
                  {!i.active ? <Badge>Escondido</Badge> : null}
                  {i.options.length > 0 ? <span className="muted small">{i.options.length === 1 ? '1 extra' : `${i.options.length} extras`}</span> : null}
                </span>
              </button>
              <div className="adm-row-foot">
                <Switch checked={i.available} onChange={(v) => onAvailable(i, v)} label="Disponível" />
                <span className="adm-row-actions">
                  <Button size="sm" variant="secondary" aria-label={`Editar ${i.name}`} onClick={() => onEditItem(i.id)}>
                    Editar
                  </Button>
                  {canMove ? (
                    <span className="move-btns">
                      <Button size="sm" variant="quiet" aria-label={`Subir ${i.name}`} disabled={ii === 0} onClick={() => onMoveItem(i.id, -1)}>
                        ↑
                      </Button>
                      <Button size="sm" variant="quiet" aria-label={`Descer ${i.name}`} disabled={ii === visible.length - 1} onClick={() => onMoveItem(i.id, 1)}>
                        ↓
                      </Button>
                    </span>
                  ) : null}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
