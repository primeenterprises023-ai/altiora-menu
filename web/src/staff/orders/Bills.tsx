// Contas em aberto, agrupadas por mesa (usado pelo empregado e pelo gerente).
import { useMemo } from 'react';
import type { OrderView } from '../../../../shared/types';
import { fmtTime } from '../../lib/format';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';

export interface Bill {
  tableId: string;
  number: number;
  label: string | null;
  orders: OrderView[];
  dueCents: number;
}

/** Junta os pedidos por pagar de cada mesa (mesas por ordem de número; pedidos do mais antigo para o mais recente). */
export function groupBills(orders: OrderView[]): Bill[] {
  const byTable = new Map<string, OrderView[]>();
  for (const o of orders) byTable.set(o.table_id, [...(byTable.get(o.table_id) ?? []), o]);
  return [...byTable.entries()]
    .map(([tableId, list]) => ({
      tableId,
      number: list[0]!.table_number,
      label: list[0]!.table_label,
      orders: [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
      dueCents: list.reduce((n, o) => n + (o.payment?.due_cents ?? 0), 0),
    }))
    .sort((a, b) => a.number - b.number);
}

export function totalDue(orders: OrderView[]): number {
  return orders.reduce((n, o) => n + (o.payment?.due_cents ?? 0), 0);
}

interface Props {
  orders: OrderView[];
  timezone?: string;
  onPay: (order: OrderView) => void;
  onOpen: (order: OrderView) => void;
}

export function Bills({ orders, timezone, onPay, onOpen }: Props) {
  const bills = useMemo(() => groupBills(orders), [orders]);
  return (
    <div className="card-grid">
      {bills.map((b) => (
        <section key={b.tableId} className="ticket bill" aria-label={`Mesa ${b.number}`}>
          <header className="bill-head">
            <div>
              <p className="oc-table-label">Mesa</p>
              <p className="bill-table voice">
                {b.number} {b.label ? <span className="oc-table-name muted">{b.label}</span> : null}
              </p>
            </div>
            <div className="bill-total">
              <p className="oc-table-label">Em aberto</p>
              <Money className="bill-amount" cents={b.dueCents} />
            </div>
          </header>
          <ul className="bill-list">
            {b.orders.map((o) => (
              <li key={o.id} className="bill-row">
                <div className="grow">
                  <p>
                    <strong className="num">#{o.order_number}</strong> <StatusBadge status={o.status} />
                  </p>
                  <p className="muted small">
                    {fmtTime(o.created_at, timezone)} · total <Money cents={o.total_cents} />
                    {o.payment && o.payment.paid_cents > 0 ? (
                      <>
                        {' '}· já pago <Money cents={o.payment.paid_cents} />
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="bill-due">
                  <Money className="bill-amount" cents={o.payment?.due_cents ?? 0} />
                  <div className="row-wrap">
                    <Button size="sm" variant="secondary" onClick={() => onPay(o)}>
                      Registar pagamento
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => onOpen(o)}>
                      Detalhes
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
