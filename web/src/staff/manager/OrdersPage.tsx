// Pedidos do gerente: em curso, contas por pagar e histórico.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAYMENT_STATE_LABEL } from '../../../../shared/payments';
import { nextAction } from '../../../../shared/status';
import type { OrderView, StaffTable } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { SelectField } from '../../ui/Fields';
import { Money } from '../../ui/Money';
import { ConnectionPill } from '../../ui/Pill';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { orders as ordersApi, tables as tablesApi } from '../data';
import { useDocumentTitle, useNow, useStaffStream } from '../hooks';
import { Bills, totalDue } from '../orders/Bills';
import { OrderCard } from '../orders/OrderCard';
import { OrderSheet } from '../orders/OrderSheet';
import { PaymentSheet } from '../orders/PaymentSheet';
import { useActiveOrders, useOrderActions, useOrders } from '../orders/useOrders';
import { useRestaurant } from '../Shell';
import { CallsBanner } from '../waiter/CallsBanner';
import { useWaiterCalls } from '../waiter/useWaiterCalls';

type Tab = 'curso' | 'pagar' | 'historico';
type HistoryFilter = 'todos' | 'entregue' | 'cancelado';
const PAGE = 30;

const paymentTone = (state: string | undefined): 'ok' | 'warn' | 'plain' => (state === 'pago' || state === 'isento' ? 'ok' : state === 'parcial' || state === 'pendente' ? 'warn' : 'plain');

export default function OrdersPage() {
  const { restaurant } = useRestaurant();
  const tz = restaurant?.timezone;
  const active = useActiveOrders();
  const unpaid = useOrders({ unpaid: true }, { resetKey: 'unpaid' });
  const { busy, run } = useOrderActions(active);
  const now = useNow(20_000);
  const toast = useToast();
  const wcalls = useWaiterCalls((arrived) => {
    for (const c of arrived) toast.show(`Mesa ${c.table_number} está a chamar o garçom.`);
  });
  const stream = useStaffStream();
  const tables = useLive<{ tables: StaffTable[] }>((signal) => tablesApi.list(signal), { stream, pollMs: 60_000, safetyMs: 300_000 });

  const [tab, setTab] = useState<Tab>('curso');
  const [openId, setOpenId] = useState<string | null>(null);
  const [payOrder, setPayOrder] = useState<OrderView | null>(null);

  const list = active.data?.orders ?? [];
  const skewMs = active.data?.skewMs ?? 0;
  const groups = useMemo(
    () => [
      { id: 'novo', title: 'Novos', orders: list.filter((o) => o.status === 'novo') },
      { id: 'em_preparacao', title: 'Em preparação', orders: list.filter((o) => o.status === 'em_preparacao') },
      { id: 'pronto', title: 'Prontos a entregar', orders: list.filter((o) => o.status === 'pronto') },
    ],
    [list],
  );
  const unpaidList = unpaid.data?.orders ?? [];
  const due = totalDue(unpaidList);
  useDocumentTitle('Pedidos');

  // o histórico só se carrega quando se abre (e fica guardado enquanto se muda de separador)
  const [historyOpened, setHistoryOpened] = useState(false);
  useEffect(() => {
    if (tab === 'historico') setHistoryOpened(true);
  }, [tab]);
  const [historyVersion, setHistoryVersion] = useState(0);

  const refreshAll = () => {
    active.refresh();
    unpaid.refresh();
    setHistoryVersion((v) => v + 1);
  };

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'curso', label: 'Em curso', count: list.length },
    { id: 'pagar', label: 'Por pagar', count: unpaidList.length },
    { id: 'historico', label: 'Histórico' },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Pedidos</h1>
          <ConnectionPill live={active.live} error={active.error} />
        </div>
      </div>

      <StaleNotice error={active.data ? active.error : null} />
      <CallsBanner calls={wcalls.calls} now={now} skewMs={wcalls.skewMs} busy={wcalls.busy} onAttend={(c) => void wcalls.attend(c)} />

      <div className="tabs mtabs" role="tablist" aria-label="Secções dos pedidos">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`otab-${t.id}`} aria-selected={tab === t.id} aria-controls={`opanel-${t.id}`} className="tab" onClick={() => setTab(t.id)}>
            {t.label}
            {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`opanel-${tab}`} aria-labelledby={`otab-${tab}`}>
        {tab === 'curso' ? (
          active.loading ? (
            <Loading rows={5} />
          ) : active.error && !active.data ? (
            <ErrorState error={active.error} onRetry={active.refresh} />
          ) : list.length === 0 ? (
            <EmptyState title="Sem pedidos em curso.">Quando um cliente fizer um pedido, aparece aqui.</EmptyState>
          ) : (
            <div className="board">
              {groups.map((g) => (
                <section key={g.id} className={`board-col${g.orders.length === 0 ? ' is-empty' : ''}`} aria-label={g.title}>
                  <h2 className="section-title">
                    {g.title} ({g.orders.length})
                  </h2>
                  {g.orders.length === 0 ? (
                    <p className="muted small">Nenhum pedido.</p>
                  ) : (
                    <div className="card-grid">
                      {g.orders.map((o) => (
                        <OrderCard
                          key={o.id}
                          order={o}
                          now={now}
                          skewMs={skewMs}
                          showPayment
                          action={nextAction('manager', o.status)}
                          busy={busy.has(o.id)}
                          onAction={(order, to) => void run(order, to)}
                          onOpen={(order) => setOpenId(order.id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )
        ) : null}

        {tab === 'pagar' ? (
          unpaid.loading && !unpaid.data ? (
            <Loading rows={3} />
          ) : unpaid.error && !unpaid.data ? (
            <ErrorState error={unpaid.error} onRetry={unpaid.refresh} />
          ) : unpaidList.length === 0 ? (
            <EmptyState title="Não há contas por pagar.">Os pedidos pagos, isentos ou cancelados não aparecem aqui.</EmptyState>
          ) : (
            <div className="stack">
              <p className="lead-line">
                Por receber, no total: <Money className="bill-amount" cents={due} />
              </p>
              <Bills orders={unpaidList} timezone={tz} onPay={setPayOrder} onOpen={(o) => setOpenId(o.id)} />
            </div>
          )
        ) : null}

        {historyOpened ? (
          <div hidden={tab !== 'historico'}>
            <History tables={tables.data?.tables ?? []} timezone={tz} version={historyVersion} onOpen={setOpenId} />
          </div>
        ) : null}
      </div>

      <OrderSheet orderId={openId} role="manager" onClose={() => setOpenId(null)} onChanged={refreshAll} />
      <PaymentSheet order={payOrder} dueCents={payOrder?.payment?.due_cents ?? 0} onClose={() => setPayOrder(null)} onRecorded={refreshAll} />
    </div>
  );
}

function History({ tables, timezone, version, onOpen }: { tables: StaffTable[]; timezone?: string; version: number; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<HistoryFilter>('todos');
  const [tableId, setTableId] = useState('');
  const [rows, setRows] = useState<OrderView[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (before: string | undefined) => {
      const r = await ordersApi.list({ scope: 'history', status: filter === 'todos' ? undefined : [filter], tableId: tableId || undefined, before, limit: PAGE });
      return r.orders;
    },
    [filter, tableId],
  );

  // recomeça sempre que muda um filtro ou alguém altera um pedido
  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    fetchPage(undefined)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows(page);
        setMore(page.length >= PAGE);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (generation.current !== mine) return;
        setError(err instanceof Error ? err : new Error(errorText(err)));
        setLoading(false);
      });
  }, [fetchPage, version, retry]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(last.created_at);
      if (generation.current !== mine) return;
      setRows((cur) => {
        const seen = new Set(cur.map((o) => o.id));
        return [...cur, ...page.filter((o) => !seen.has(o.id))];
      });
      setMore(page.length >= PAGE);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(errorText(err)));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="stack">
      <div className="filters">
        <SelectField label="Estado" value={filter} onChange={(e) => setFilter(e.target.value as HistoryFilter)}>
          <option value="todos">Entregues e cancelados</option>
          <option value="entregue">Só entregues</option>
          <option value="cancelado">Só cancelados</option>
        </SelectField>
        <SelectField label="Mesa" value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">Todas as mesas</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              Mesa {t.table_number}
              {t.label ? ` · ${t.label}` : ''}
            </option>
          ))}
        </SelectField>
      </div>

      {loading ? (
        <Loading rows={5} />
      ) : error && rows.length === 0 ? (
        <ErrorState error={error} onRetry={() => setRetry((n) => n + 1)} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nenhum pedido encontrado.">Experimente mudar os filtros.</EmptyState>
      ) : (
        <>
          <ul className="hist-list">
            {rows.map((o) => (
              <li key={o.id}>
                <button type="button" className="hist-row" onClick={() => onOpen(o.id)}>
                  <span className="hist-title">
                    <strong className="num">#{o.order_number}</strong> Mesa {o.table_number}
                    {o.table_label ? <span className="muted"> · {o.table_label}</span> : null}
                  </span>
                  <Money className="hist-amount" cents={o.total_cents} />
                  <span className="hist-date muted small">
                    {fmtDateTime(o.created_at, timezone)}
                    {o.source === 'staff' ? ' · feito pelo empregado' : ''}
                  </span>
                  <span className="hist-badges">
                    <StatusBadge status={o.status} />
                    {o.status !== 'cancelado' && o.payment ? <Badge tone={paymentTone(o.payment.state)}>{PAYMENT_STATE_LABEL[o.payment.state]}</Badge> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {error ? (
            <div className="notice notice-danger" role="alert">
              {error.message}
            </div>
          ) : null}
          {more ? (
            <Button variant="secondary" block loading={loadingMore} onClick={() => void loadMore()}>
              Carregar mais
            </Button>
          ) : (
            <p className="muted small center">Não há mais pedidos.</p>
          )}
        </>
      )}
    </div>
  );
}
