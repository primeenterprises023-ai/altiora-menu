// Painel da cozinha: pedidos novos, em preparação e prontos, com aviso sonoro e lista de pratos esgotados.
import { useMemo, useRef, useState } from 'react';
import { nextAction, type OrderStatus, type StaffRole } from '../../../../shared/status';
import type { StaffMenu } from '../../../../shared/types';
import { local } from '../../lib/storage';
import { useLive } from '../../lib/live';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Fields';
import { ConnectionPill } from '../../ui/Pill';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { menu as menuApi } from '../data';
import { useDocumentTitle, useNow, useStaffEvents, useStaffStream } from '../hooks';
import { OrderCard } from '../orders/OrderCard';
import { OrderSheet } from '../orders/OrderSheet';
import { useArrivals } from '../orders/useArrivals';
import { useActiveOrders, useOrderActions } from '../orders/useOrders';
import { useSession } from '../session';
import { chime, unlockSound } from '../sound';
import { StockSheet } from './StockSheet';

const COLUMNS: Array<{ status: Extract<OrderStatus, 'novo' | 'em_preparacao' | 'pronto'>; title: string; empty: string }> = [
  { status: 'novo', title: 'Novos', empty: 'Sem pedidos novos.' },
  { status: 'em_preparacao', title: 'Em preparação', empty: 'Nada em preparação.' },
  { status: 'pronto', title: 'Prontos', empty: 'Nenhum pedido pronto à espera.' },
];

const SOUND_KEY = 'altiora:kitchen-sound';

export default function KitchenPage() {
  const { user } = useSession();
  const role = (user?.role ?? 'kitchen') as StaffRole;
  const toast = useToast();
  const stream = useStaffStream();
  const list = useActiveOrders();
  const { busy, run } = useOrderActions(list);
  const stock = useLive<StaffMenu>((signal) => menuApi.get(signal), { stream, pollMs: 30_000, safetyMs: 90_000 });
  const now = useNow(15_000);

  const [tab, setTab] = useState<OrderStatus>('novo');
  const [openId, setOpenId] = useState<string | null>(null);
  const [stockOpen, setStockOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(() => local.get(SOUND_KEY) === '1');
  const [soundBlocked, setSoundBlocked] = useState(false);

  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  const orders = list.data?.orders;
  const skewMs = list.data?.skewMs ?? 0;
  const byStatus = useMemo(() => {
    const out: Record<string, NonNullable<typeof orders>> = { novo: [], em_preparacao: [], pronto: [] };
    for (const o of orders ?? []) out[o.status]?.push(o);
    return out;
  }, [orders]);
  const newCount = byStatus.novo?.length ?? 0;
  useDocumentTitle(newCount > 0 ? `(${newCount}) Cozinha` : 'Cozinha');

  // pedidos novos que chegaram depois da primeira leitura: destacam-se e (se o som estiver ligado) tocam
  const fresh = useArrivals(
    orders,
    (o) => o.status === 'novo',
    () => {
      if (soundRef.current && !chime()) setSoundBlocked(true);
    },
  );

  // se o gerente cancelar um pedido, a cozinha tem de saber (não basta ele desaparecer da lista)
  useStaffEvents((e) => {
    if (e.type === 'order.status' && e.data.to === 'cancelado') {
      toast.show(`O pedido #${String(e.data.order_number)} da mesa ${String(e.data.table_number)} foi cancelado.`, 'danger');
    }
  });

  const toggleSound = async (on: boolean) => {
    setSoundOn(on);
    local.set(SOUND_KEY, on ? '1' : '0');
    if (!on) return;
    const ready = await unlockSound();
    if (ready && chime()) setSoundBlocked(false);
    else {
      setSoundBlocked(true);
      toast.show('O navegador não deixou ligar o som. Toque no botão "Ativar som".', 'danger');
    }
  };

  const soldOutCount = useMemo(
    () => (stock.data?.categories ?? []).filter((c) => c.active).reduce((n, c) => n + c.items.filter((i) => i.active && !i.available).length, 0),
    [stock.data],
  );

  return (
    <div className="page kitchen">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Cozinha</h1>
          <ConnectionPill live={list.live} error={list.error} />
        </div>
        <div className="toolbar">
          <Switch checked={soundOn} onChange={(v) => void toggleSound(v)} label="Aviso sonoro" />
          <Button variant="secondary" onClick={() => setStockOpen(true)}>
            Esgotados{soldOutCount > 0 ? ` (${soldOutCount})` : ''}
          </Button>
        </div>
      </div>

      {soundOn && soundBlocked ? (
        <div className="notice" role="status">
          <span>O som está desligado neste aparelho até tocar no ecrã. </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void unlockSound().then((ok) => {
                if (ok) {
                  chime();
                  setSoundBlocked(false);
                }
              });
            }}
          >
            Ativar som
          </Button>
        </div>
      ) : null}
      {list.data?.truncated ? <div className="notice">Há muitos pedidos em curso: só se mostram os mais antigos.</div> : null}
      <StaleNotice error={list.data ? list.error : null} />

      {list.loading ? (
        <Loading rows={6} label="A carregar os pedidos…" />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.refresh} />
      ) : (
        <>
          <div className="tabs ktabs" role="tablist" aria-label="Estado dos pedidos">
            {COLUMNS.map((c) => (
              <button key={c.status} type="button" role="tab" id={`tab-${c.status}`} aria-selected={tab === c.status} aria-controls={`col-${c.status}`} className="tab" onClick={() => setTab(c.status)}>
                {c.title}
                <span className="tab-count">{byStatus[c.status]?.length ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="kboard">
            {COLUMNS.map((c) => {
              const items = byStatus[c.status] ?? [];
              return (
                <section key={c.status} id={`col-${c.status}`} className="kcol" data-active={tab === c.status} role="tabpanel" aria-labelledby={`tab-${c.status}`}>
                  <h2 className="kcol-title">
                    {c.title} <span className="tab-count">{items.length}</span>
                  </h2>
                  {items.length === 0 ? (
                    <EmptyState title={c.empty} />
                  ) : (
                    <div className="kcol-list">
                      {items.map((o) => {
                        const act = nextAction(role, o.status);
                        return (
                          <OrderCard
                            key={o.id}
                            order={o}
                            now={now}
                            skewMs={skewMs}
                            action={act}
                            busy={busy.has(o.id)}
                            onAction={(order, to) => void run(order, to)}
                            onOpen={(order) => setOpenId(order.id)}
                            fresh={fresh.has(o.id)}
                            footer={o.status === 'pronto' && !act ? <p className="muted small oc-wait">À espera de ser entregue na mesa.</p> : null}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      <OrderSheet orderId={openId} role={role} onClose={() => setOpenId(null)} onChanged={list.refresh} />
      <StockSheet open={stockOpen} onClose={() => setStockOpen(false)} live={stock} />
    </div>
  );
}
