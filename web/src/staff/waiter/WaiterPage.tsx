// Painel do empregado de mesa: pratos prontos a entregar, pedidos em curso, mesas e contas por pagar.
import { useMemo, useRef, useState } from 'react';
import { nextAction, type StaffRole } from '../../../../shared/status';
import type { OrderView, StaffTable } from '../../../../shared/types';
import { useLive } from '../../lib/live';
import { local } from '../../lib/storage';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Fields';
import { Money } from '../../ui/Money';
import { ConnectionPill } from '../../ui/Pill';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { tables as tablesApi } from '../data';
import { useDocumentTitle, useNow, useStaffStream } from '../hooks';
import { Bills } from '../orders/Bills';
import { OrderCard } from '../orders/OrderCard';
import { OrderSheet } from '../orders/OrderSheet';
import { PaymentSheet } from '../orders/PaymentSheet';
import { useArrivals } from '../orders/useArrivals';
import { useActiveOrders, useOrderActions, useOrders } from '../orders/useOrders';
import { useRestaurant } from '../Shell';
import { useSession } from '../session';
import { chime, unlockSound } from '../sound';
import { CallsBanner } from './CallsBanner';
import { ManualOrderSheet } from './ManualOrderSheet';
import { TableSheet } from './TableSheet';
import { useWaiterCalls } from './useWaiterCalls';

type Tab = 'entregar' | 'curso' | 'mesas' | 'pagar';
const SOUND_KEY = 'altiora:waiter-sound';

export default function WaiterPage() {
  const { user } = useSession();
  const role = (user?.role ?? 'waiter') as StaffRole;
  const toast = useToast();
  const stream = useStaffStream();
  const { restaurant } = useRestaurant();
  const tz = restaurant?.timezone;
  const active = useActiveOrders();
  const unpaid = useOrders({ unpaid: true }, { resetKey: 'unpaid' });
  const tables = useLive<{ tables: StaffTable[] }>((signal) => tablesApi.list(signal), { stream, pollMs: 30_000, safetyMs: 120_000 });
  const { busy, run } = useOrderActions(active);
  const now = useNow(20_000);

  const [tab, setTab] = useState<Tab>('entregar');
  const [openId, setOpenId] = useState<string | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [manual, setManual] = useState<{ open: boolean; tableId: string | null }>({ open: false, tableId: null });
  const [payOrder, setPayOrder] = useState<OrderView | null>(null);
  const [soundOn, setSoundOn] = useState(() => local.get(SOUND_KEY) === '1');
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  // mesas que chamaram o garçom: aviso (e som/vibração, se estiverem ligados) assim que chega uma chamada nova
  const wcalls = useWaiterCalls((arrived) => {
    for (const c of arrived) toast.show(`Mesa ${c.table_number} está a chamar o garçom.`);
    if (soundRef.current) {
      chime();
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {
        /* sem vibração neste aparelho */
      }
    }
  });
  const callingTables = useMemo(() => new Set(wcalls.calls.map((c) => c.table_id)), [wcalls.calls]);

  const orders = active.data?.orders;
  const skewMs = active.data?.skewMs ?? 0;
  const ready = useMemo(() => (orders ?? []).filter((o) => o.status === 'pronto').sort((a, b) => Date.parse(a.ready_at ?? a.created_at) - Date.parse(b.ready_at ?? b.created_at)), [orders]);
  const cooking = useMemo(() => (orders ?? []).filter((o) => o.status === 'novo' || o.status === 'em_preparacao'), [orders]);
  const unpaidOrders = unpaid.data?.orders ?? [];
  const attention = ready.length + wcalls.calls.length;
  useDocumentTitle(attention > 0 ? `(${attention}) Sala` : 'Sala');

  // pratos que acabaram de ficar prontos: aviso (e som/vibração se estiverem ligados)
  const fresh = useArrivals(
    orders,
    (o) => o.status === 'pronto',
    (arrived) => {
      for (const o of arrived) toast.show(`Pedido #${o.order_number} da mesa ${o.table_number} está pronto a entregar.`);
      if (soundRef.current) {
        chime();
        try {
          navigator.vibrate?.(200);
        } catch {
          /* sem vibração neste aparelho */
        }
      }
    },
  );

  const tableList = tables.data?.tables ?? [];
  const tableById = useMemo(() => new Map(tableList.map((t) => [t.id, t])), [tableList]);
  const openTable = tableId ? (tableById.get(tableId) ?? null) : null;

  const refreshAll = () => {
    active.refresh();
    unpaid.refresh();
    tables.refresh();
    wcalls.list.refresh();
  };

  const toggleSound = async (on: boolean) => {
    setSoundOn(on);
    local.set(SOUND_KEY, on ? '1' : '0');
    if (on) {
      const ok = await unlockSound();
      if (ok) chime();
      else toast.show('O navegador não deixou ligar o som. Toque outra vez no botão.', 'danger');
    }
  };

  const loading = active.loading || (tables.loading && !tables.data);
  const failed = active.error && !active.data ? active.error : null;

  const tiles = useMemo(() => {
    return tableList
      .filter((t) => t.active)
      .map((t) => {
        const mine = (orders ?? []).filter((o) => o.table_id === t.id);
        const due = unpaidOrders.filter((o) => o.table_id === t.id).reduce((n, o) => n + (o.payment?.due_cents ?? 0), 0);
        return { table: t, ready: mine.filter((o) => o.status === 'pronto').length, cooking: mine.filter((o) => o.status !== 'pronto').length, due, calling: callingTables.has(t.id) };
      });
  }, [tableList, orders, unpaidOrders, callingTables]);

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'entregar', label: 'A entregar', count: ready.length },
    { id: 'curso', label: 'Em curso', count: cooking.length },
    { id: 'mesas', label: 'Mesas' },
    { id: 'pagar', label: 'Por pagar', count: unpaidOrders.length },
  ];

  return (
    <div className="page waiter">
      <div className="page-head page-head-inline">
        <div>
          <h1 className="page-title voice">Sala</h1>
          <ConnectionPill live={active.live} error={active.error} />
        </div>
        <Button onClick={() => setManual({ open: true, tableId: null })}>Novo pedido</Button>
      </div>

      <StaleNotice error={active.data ? active.error : null} />
      {wcalls.list.error && !wcalls.list.data ? (
        <div className="notice notice-danger" role="status">
          <strong>Não foi possível ver as chamadas das mesas.</strong> A tentar de novo automaticamente.
        </div>
      ) : null}
      <CallsBanner calls={wcalls.calls} now={now} skewMs={wcalls.skewMs} busy={wcalls.busy} onAttend={(c) => void wcalls.attend(c)} />
      <Switch checked={soundOn} onChange={(v) => void toggleSound(v)} label="Avisar com som quando uma mesa chamar ou um pedido ficar pronto" />

      <div className="tabs wtabs" role="tablist" aria-label="Secções da sala">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`wtab-${t.id}`} aria-selected={tab === t.id} aria-controls={`wpanel-${t.id}`} className="tab" onClick={() => setTab(t.id)}>
            {t.label}
            {t.count !== undefined ? <span className={`tab-count${t.id === 'entregar' && t.count > 0 ? ' tab-count-alert' : ''}`}>{t.count}</span> : null}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading rows={5} label="A carregar…" />
      ) : failed ? (
        <ErrorState error={failed} onRetry={refreshAll} />
      ) : (
        <div role="tabpanel" id={`wpanel-${tab}`} aria-labelledby={`wtab-${tab}`}>
          {tab === 'entregar' ? (
            <div className="stack">
              {ready.length === 0 ? (
                <EmptyState title="Nenhum pedido pronto para entregar.">Quando a cozinha marcar um pedido como pronto, aparece aqui.</EmptyState>
              ) : (
                <div className="card-grid">
                  {ready.map((o) => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      now={now}
                      skewMs={skewMs}
                      action={nextAction(role, o.status)}
                      busy={busy.has(o.id)}
                      onAction={(order, to) => void run(order, to)}
                      onOpen={(order) => setOpenId(order.id)}
                      fresh={fresh.has(o.id)}
                      showPayment
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {tab === 'curso' ? (
            cooking.length === 0 ? (
              <EmptyState title="Sem pedidos na cozinha neste momento." />
            ) : (
              <div className="card-grid">
                {cooking.map((o) => (
                  <OrderCard key={o.id} order={o} now={now} skewMs={skewMs} showStatus onOpen={(order) => setOpenId(order.id)} />
                ))}
              </div>
            )
          ) : null}

          {tab === 'mesas' ? (
            tiles.length === 0 ? (
              <EmptyState title="Ainda não há mesas.">O gerente cria as mesas em "Mesas e QR Codes".</EmptyState>
            ) : (
              <ul className="tile-grid">
                {tiles.map(({ table: t, ready: r, cooking: c, due, calling }) => (
                  <li key={t.id}>
                    <button type="button" className={`table-tile${r > 0 ? ' has-ready' : ''}${calling ? ' has-call' : ''}`} onClick={() => setTableId(t.id)} aria-label={`Mesa ${t.table_number}${t.label ? `, ${t.label}` : ''}`}>
                      <span className="tt-num voice">{t.table_number}</span>
                      {t.label ? <span className="tt-label muted">{t.label}</span> : null}
                      <span className="tt-state">
                        {calling ? <span className="tt-call">A chamar o garçom</span> : null}
                        {r > 0 ? (
                          <strong>{r === 1 ? 'Pronto a entregar' : `${r} prontos a entregar`}</strong>
                        ) : c > 0 ? (
                          `${c} em curso`
                        ) : due > 0 ? (
                          <>
                            Por pagar · <Money cents={due} />
                          </>
                        ) : (
                          <span className="muted">Livre</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {tab === 'pagar' ? (
            unpaid.loading && !unpaid.data ? (
              <Loading rows={3} />
            ) : unpaid.error && !unpaid.data ? (
              <ErrorState error={unpaid.error} onRetry={unpaid.refresh} />
            ) : unpaidOrders.length === 0 ? (
              <EmptyState title="Não há contas por pagar.">Os pedidos pagos ou isentos não aparecem aqui.</EmptyState>
            ) : (
              <Bills orders={unpaidOrders} timezone={tz} onPay={(o) => setPayOrder(o)} onOpen={(o) => setOpenId(o.id)} />
            )
          ) : null}
        </div>
      )}

      <TableSheet
        table={openTable}
        active={(orders ?? []).filter((o) => o.table_id === tableId)}
        unpaid={unpaidOrders.filter((o) => o.table_id === tableId)}
        now={now}
        skewMs={skewMs}
        role={role}
        busy={busy}
        onClose={() => setTableId(null)}
        onNewOrder={(id) => setManual({ open: true, tableId: id })}
        onOpenOrder={(id) => setOpenId(id)}
        onAction={(order, to) => void run(order, to)}
        onPay={(order) => setPayOrder(order)}
        onChanged={refreshAll}
      />
      <ManualOrderSheet open={manual.open} tableId={manual.tableId} tables={tableList} onClose={() => setManual({ open: false, tableId: null })} onCreated={() => { refreshAll(); setTab('curso'); }} />
      <OrderSheet orderId={openId} role={role} onClose={() => setOpenId(null)} onChanged={refreshAll} />
      <PaymentSheet order={payOrder} dueCents={payOrder?.payment?.due_cents ?? 0} onClose={() => setPayOrder(null)} onRecorded={refreshAll} />
    </div>
  );
}
