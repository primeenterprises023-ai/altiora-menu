import type { ReactNode } from 'react';
import { CUSTOMER_STATUS_LABEL, STATUS_LABEL, type OrderStatus } from '../../../shared/status';

/** Estado do pedido: o texto diz sempre o estado; a cor só reforça. */
export function StatusBadge({ status, forCustomer }: { status: OrderStatus; forCustomer?: boolean }) {
  return <span className={`badge badge-${status}`}>{forCustomer ? CUSTOMER_STATUS_LABEL[status] : STATUS_LABEL[status]}</span>;
}

/** Etiqueta pequena (ex.: estado do pagamento). O texto diz sempre o que é; a cor só reforça. */
export function Badge({ tone = 'plain', children }: { tone?: 'ok' | 'warn' | 'danger' | 'plain'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
