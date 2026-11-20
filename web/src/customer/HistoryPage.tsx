import { useEffect } from 'react';
import { fmtTime, kz, plural } from '../lib/format';
import { useLive } from '../lib/live';
import { Link } from '../lib/router';
import { applyAccent } from '../lib/theme';
import { StatusBadge } from '../ui/Badge';
import { EmptyState, ErrorState, Loading } from '../ui/States';
import { Money } from '../ui/Money';
import { publicApi } from './data';

/** Todos os pedidos feitos nesta mesa durante a visita atual. */
export function HistoryPage({ token }: { token: string }) {
  const orders = useLive((signal) => publicApi.sessionOrders(token, signal), { pollMs: 8000, safetyMs: 8000, resetKey: token });
  // só para o nome do restaurante, da mesa e a cor; o menu em si não é mostrado aqui
  const menu = useLive((signal) => publicApi.menu(token, signal), { pollMs: 120_000, safetyMs: 120_000, resetKey: token });
  const info = menu.data;

  useEffect(() => {
    if (!info) return;
    applyAccent(info.restaurant.accent_color);
    document.title = `Os meus pedidos — ${info.restaurant.name}`;
  }, [info]);

  const list = orders.data?.orders ?? [];
  const counted = list.filter((o) => o.status !== 'cancelado');
  const total = counted.reduce((sum, o) => sum + o.total_cents, 0);
  const tableName = info?.table ? `Mesa ${info.table.number}${info.table.label ? `, ${info.table.label}` : ''}` : null;

  return (
    <div className="order-page">
      <header className="page-head">
        <Link className="back-link" to={`/menu/${token}`}>
          Voltar ao menu
        </Link>
        <h1 className="voice">Os meus pedidos</h1>
        {info ? (
          <p className="muted">
            {tableName} <span aria-hidden="true">·</span> {info.restaurant.name}
          </p>
        ) : null}
      </header>

      {orders.loading ? (
        <Loading rows={5} label="A carregar os pedidos…" />
      ) : !orders.data ? (
        <ErrorState error={orders.error} onRetry={orders.refresh} />
      ) : list.length === 0 ? (
        <EmptyState title="Ainda não fez nenhum pedido">Quando enviar um pedido, ele aparece aqui.</EmptyState>
      ) : (
        <>
          <ul className="history">
            {list.map((o) => (
              <li key={o.public_code}>
                <Link className={`history-row${o.status === 'cancelado' ? ' history-row-off' : ''}`} to={`/pedido/${o.public_code}`}>
                  <span className="history-number voice">Pedido {o.order_number}</span>
                  <span className="history-time muted">{fmtTime(o.created_at)}</span>
                  <StatusBadge status={o.status} forCustomer />
                  <Money className="history-total" cents={o.total_cents} />
                </Link>
              </li>
            ))}
          </ul>
          <div className="history-sum ticket">
            <div className="leader comanda-total">
              <span className="lead voice">Total</span>
              <span className="fill" aria-hidden="true" />
              <span className="tail voice">{kz(total)}</span>
            </div>
            <p className="muted hint">
              {plural(counted.length, 'pedido', 'pedidos')} nesta mesa; os cancelados não contam. O pagamento é feito diretamente no restaurante.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
