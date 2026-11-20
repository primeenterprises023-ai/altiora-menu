import type { ReactNode } from 'react';
import type { OrderStatus } from '../../../../shared/status';
import { PAYMENT_STATE_LABEL } from '../../../../shared/payments';
import type { OrderItemView, OrderView } from '../../../../shared/types';
import { fmtElapsed } from '../../lib/format';
import { Badge, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { ageMs, urgency } from './lateness';

/** Linhas de um pedido: quantidade, nome, extras e notas (as notas dos clientes ficam sempre em destaque). */
export function OrderItems({ items, prices = false }: { items: OrderItemView[]; prices?: boolean }) {
  return (
    <ul className="oc-items">
      {items.map((i) => (
        <li key={i.id}>
          <span className="oc-qty num">{i.quantity}×</span>
          <div className="oc-line">
            {prices ? (
              <div className="leader">
                <span className="lead oc-name">{i.name}</span>
                <span className="fill" aria-hidden="true" />
                <Money className="tail" cents={i.line_total_cents} />
              </div>
            ) : (
              <span className="oc-name">{i.name}</span>
            )}
            {i.options.length > 0 ? (
              <p className="oc-opts muted">
                {i.options.map((o) => `+ ${o.name}${o.quantity > 1 ? ` ×${o.quantity}` : ''}`).join(' · ')}
              </p>
            ) : null}
            {i.notes ? (
              <p className="oc-item-note">
                <span className="marker">{i.notes}</span>
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface OrderCardProps {
  order: OrderView;
  now: number;
  skewMs: number;
  /** Ação principal do perfil para este pedido (ex.: "Iniciar preparação"). */
  action?: { label: string; to: OrderStatus } | null;
  busy?: boolean;
  onAction?: (order: OrderView, to: OrderStatus) => void;
  onOpen?: (order: OrderView) => void;
  /** Acabou de chegar: destaca-se durante alguns segundos. */
  fresh?: boolean;
  /** Mostra o estado do pedido (nas listas que misturam estados). */
  showStatus?: boolean;
  /** Mostra o estado do pagamento (só para gerente e empregado). */
  showPayment?: boolean;
  /** Esconde as linhas do pedido (listas compactas). */
  summary?: boolean;
  footer?: ReactNode;
}

export function OrderCard({ order, now, skewMs, action, busy, onAction, onOpen, fresh, showStatus, showPayment, summary, footer }: OrderCardProps) {
  const age = ageMs(order, now, skewMs);
  const urg = urgency(order, now, skewMs);
  const units = order.items.reduce((n, i) => n + i.quantity, 0);
  return (
    <article className={`ticket order-card urg-${urg}${fresh ? ' is-fresh' : ''}`} data-order-id={order.id} data-status={order.status} aria-label={`Pedido ${order.order_number}, mesa ${order.table_number}`}>
      <header className="oc-head">
        <div className="oc-table">
          <span className="oc-table-label">Mesa</span>
          <span className="oc-table-num voice">{order.table_number}</span>
          {order.table_label ? <span className="oc-table-name muted">{order.table_label}</span> : null}
        </div>
        <div className="oc-meta">
          <span className="oc-number num">#{order.order_number}</span>
          <span className={`oc-age${urg === 'ok' ? '' : ` oc-age-${urg}`}`}>
            {fmtElapsed(age)}
            {urg === 'late' ? <span className="sr-only"> — em atraso</span> : null}
          </span>
        </div>
      </header>

      {showStatus || showPayment || order.source === 'staff' ? (
        <div className="oc-tags">
          {showStatus ? <StatusBadge status={order.status} /> : null}
          {showPayment && order.payment ? (
            <Badge tone={order.payment.state === 'pago' || order.payment.state === 'isento' ? 'ok' : order.payment.state === 'parcial' ? 'warn' : 'plain'}>
              {PAYMENT_STATE_LABEL[order.payment.state]}
              {order.payment.due_cents > 0 ? <> · <Money cents={order.payment.due_cents} /></> : null}
            </Badge>
          ) : null}
          {order.source === 'staff' ? <Badge tone="plain">Registado pela equipa</Badge> : null}
        </div>
      ) : null}

      {summary ? (
        <p className="oc-summary muted">
          {units} {units === 1 ? 'unidade' : 'unidades'} · <Money cents={order.total_cents} />
        </p>
      ) : (
        <OrderItems items={order.items} />
      )}

      {order.notes ? (
        <p className="oc-order-note">
          <span className="oc-note-label">Nota do pedido</span>
          <span className="marker">{order.notes}</span>
        </p>
      ) : null}

      {action || onOpen || footer ? (
        <footer className="oc-foot">
          {footer}
          {action && onAction ? (
            <Button size="big" block loading={busy} onClick={() => onAction(order, action.to)}>
              {action.label}
            </Button>
          ) : null}
          {onOpen ? (
            <Button variant="quiet" size="sm" onClick={() => onOpen(order)}>
              Detalhes
            </Button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
