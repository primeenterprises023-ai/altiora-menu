// Estados do pedido e regras de transição.
// ATENÇÃO: espelha a função SQL order_transition_allowed() (db/migrations/0002_security.sql).
// Os testes comparam as duas implementações para todas as combinações.

export const ORDER_STATUSES = ['novo', 'em_preparacao', 'pronto', 'entregue', 'cancelado'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type StaffRole = 'manager' | 'waiter' | 'kitchen';
export type TransitionRole = StaffRole | 'system';

/** Estados "em curso": o pedido ainda precisa de atenção da equipa. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ['novo', 'em_preparacao', 'pronto'];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  novo: 'Novo',
  em_preparacao: 'Em preparação',
  pronto: 'Pronto',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};

/** Texto mostrado ao cliente na página de acompanhamento. */
export const CUSTOMER_STATUS_LABEL: Record<OrderStatus, string> = {
  novo: 'Pedido recebido',
  em_preparacao: 'Em preparação',
  pronto: 'Pronto, a caminho da sua mesa',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};

export function isOrderStatus(v: unknown): v is OrderStatus {
  return typeof v === 'string' && (ORDER_STATUSES as readonly string[]).includes(v);
}

const CORRECTIONS: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
  ['em_preparacao', 'novo'],
  ['pronto', 'em_preparacao'],
  ['entregue', 'pronto'],
  ['cancelado', 'novo'],
];

export function canTransition(role: TransitionRole, from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return false;
  if (role === 'system') return true;
  if ((role === 'kitchen' || role === 'manager') && from === 'novo' && to === 'em_preparacao') return true;
  if ((role === 'kitchen' || role === 'manager') && from === 'em_preparacao' && to === 'pronto') return true;
  if ((role === 'waiter' || role === 'manager') && from === 'pronto' && to === 'entregue') return true;
  if (role === 'manager' && to === 'cancelado' && (from === 'novo' || from === 'em_preparacao' || from === 'pronto')) return true;
  if (role === 'manager' && CORRECTIONS.some(([f, t]) => f === from && t === to)) return true;
  return false;
}

/** Cancelamentos e correções exigem um motivo (fica no histórico). */
export function transitionNeedsReason(from: OrderStatus, to: OrderStatus): boolean {
  return to === 'cancelado' || CORRECTIONS.some(([f, t]) => f === from && t === to);
}

/** Próxima ação "normal" para um perfil (usada pelos botões grandes dos painéis). */
export function nextAction(role: StaffRole, status: OrderStatus): { to: OrderStatus; label: string } | null {
  if ((role === 'kitchen' || role === 'manager') && status === 'novo') return { to: 'em_preparacao', label: 'Iniciar preparação' };
  if ((role === 'kitchen' || role === 'manager') && status === 'em_preparacao') return { to: 'pronto', label: 'Marcar como pronto' };
  if ((role === 'waiter' || role === 'manager') && status === 'pronto') return { to: 'entregue', label: 'Confirmar entrega' };
  return null;
}
