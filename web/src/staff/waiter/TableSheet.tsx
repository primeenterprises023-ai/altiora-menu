import { useState } from 'react';
import { nextAction, type OrderStatus, type StaffRole } from '../../../../shared/status';
import type { OrderView, StaffTable } from '../../../../shared/types';
import { fmtTime } from '../../lib/format';
import { Badge, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { tables as tablesApi } from '../data';
import { useRestaurant } from '../Shell';
import { ConfirmSheet } from '../orders/ConfirmSheet';
import { OrderCard } from '../orders/OrderCard';

interface Props {
  table: StaffTable | null;
  /** Pedidos em curso desta mesa. */
  active: OrderView[];
  /** Pedidos desta mesa com valor por receber. */
  unpaid: OrderView[];
  now: number;
  skewMs: number;
  role: StaffRole;
  busy: ReadonlySet<string>;
  onClose: () => void;
  onNewOrder: (tableId: string) => void;
  onOpenOrder: (orderId: string) => void;
  onAction: (order: OrderView, to: OrderStatus) => void;
  onPay: (order: OrderView) => void;
  onChanged: () => void;
}

/** Tudo sobre uma mesa: pedidos em curso, contas por pagar, novo pedido e libertar a mesa. */
export function TableSheet({ table, active, unpaid, now, skewMs, role, busy, onClose, onNewOrder, onOpenOrder, onAction, onPay, onChanged }: Props) {
  const toast = useToast();
  const { restaurant } = useRestaurant();
  const [releasing, setReleasing] = useState(false);
  const due = unpaid.reduce((n, o) => n + (o.payment?.due_cents ?? 0), 0);

  const release = async () => {
    if (!table) return;
    await tablesApi.closeSession(table.id);
    toast.show(`Mesa ${table.table_number} libertada.`);
    setReleasing(false);
    onChanged();
  };

  return (
    <>
      <Sheet
        open={table !== null}
        onClose={onClose}
        wide
        title={table ? `Mesa ${table.table_number}${table.label ? ` · ${table.label}` : ''}` : 'Mesa'}
        footer={
          table ? (
            <div className="sheet-actions">
              <Button size="big" onClick={() => onNewOrder(table.id)}>
                Novo pedido
              </Button>
              <Button size="big" variant="secondary" onClick={() => setReleasing(true)}>
                Libertar mesa
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="stack-lg">
          {active.length === 0 && unpaid.length === 0 ? <p className="muted">Mesa livre: sem pedidos em curso nem contas por pagar.</p> : null}

          {active.length > 0 ? (
            <section className="stack" aria-label="Pedidos em curso">
              <h3 className="section-title">Pedidos em curso ({active.length})</h3>
              {active.map((o) => (
                <OrderCard
                  key={o.id}
                  order={o}
                  now={now}
                  skewMs={skewMs}
                  showStatus
                  action={nextAction(role, o.status)}
                  busy={busy.has(o.id)}
                  onAction={onAction}
                  onOpen={(order) => onOpenOrder(order.id)}
                />
              ))}
            </section>
          ) : null}

          {unpaid.length > 0 ? (
            <section className="stack-sm" aria-label="Por pagar">
              <h3 className="section-title">
                Por pagar · <Money cents={due} />
              </h3>
              <ul className="bill-list">
                {unpaid.map((o) => (
                  <li key={o.id} className="bill-row">
                    <div className="grow">
                      <p>
                        <strong className="num">#{o.order_number}</strong> <StatusBadge status={o.status} />{' '}
                        {o.payment?.state === 'parcial' ? <Badge tone="warn">Pago em parte</Badge> : null}
                      </p>
                      <p className="muted small">
                        Feito às {fmtTime(o.created_at, restaurant?.timezone)} · Total <Money cents={o.total_cents} />
                      </p>
                    </div>
                    <div className="bill-due">
                      <Money className="bill-amount" cents={o.payment?.due_cents ?? 0} />
                      <Button size="sm" variant="secondary" onClick={() => onPay(o)}>
                        Registar pagamento
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </Sheet>

      <ConfirmSheet open={releasing} title={`Libertar a mesa ${table?.table_number ?? ''}`} confirmLabel="Libertar mesa" onClose={() => setReleasing(false)} onConfirm={release}>
        <p>
          Faça isto quando os clientes saírem. Quem estiver na mesa deixa de ver estes pedidos no telemóvel, e o próximo cliente começa com a mesa limpa.
        </p>
        {active.length > 0 ? (
          <p className="notice notice-danger">
            Atenção: ainda há {active.length} {active.length === 1 ? 'pedido em curso' : 'pedidos em curso'} nesta mesa. Continuam na cozinha, mas o cliente deixa de os ver.
          </p>
        ) : null}
        {due > 0 ? (
          <p className="notice notice-danger">
            Atenção: ainda faltam receber <Money cents={due} /> desta mesa. A conta continua em "Por pagar".
          </p>
        ) : null}
      </ConfirmSheet>
    </>
  );
}
