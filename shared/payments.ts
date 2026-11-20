// Pagamentos: estados e o resumo de cada pedido.
// O restaurante recebe o dinheiro diretamente (dinheiro, terminal, transferência); o sistema apenas REGISTA o que a equipa
// confirmou. Nenhum pedido passa a "pago" por ação do cliente nem por um simples clique sem indicar o valor e o método.

export const PAYMENT_METHODS = ['dinheiro', 'terminal', 'transferencia', 'outro'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['pendente', 'pago', 'isento', 'reembolsado', 'anulado'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Estado do pagamento de um pedido, visto no seu conjunto. */
export type PaymentState = 'pendente' | 'parcial' | 'pago' | 'isento' | 'reembolsado';

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  dinheiro: 'Dinheiro',
  terminal: 'Terminal de pagamento',
  transferencia: 'Transferência',
  outro: 'Outro',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pendente: 'Pendente',
  pago: 'Pago',
  isento: 'Isento',
  reembolsado: 'Reembolsado',
  anulado: 'Anulado',
};

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  pendente: 'Por pagar',
  parcial: 'Pago em parte',
  pago: 'Pago',
  isento: 'Isento',
  reembolsado: 'Reembolsado',
};

export interface OrderPaymentSummary {
  state: PaymentState;
  /** Soma dos pagamentos confirmados (estado "pago"). */
  paid_cents: number;
  /** O que falta receber (zero se o pedido estiver isento). */
  due_cents: number;
}

interface PaymentLike {
  status: PaymentStatus;
  amount_cents: number;
}

/**
 * Resume os pagamentos de um pedido.
 *  - só contam como recebido os pagamentos em estado "pago";
 *  - "isento" (cortesia autorizada pelo gerente) deixa o pedido sem nada a receber;
 *  - "reembolsado" e "anulado" não contam como recebido.
 */
export function summarizePayments(totalCents: number, payments: ReadonlyArray<PaymentLike>): OrderPaymentSummary {
  let paid = 0;
  let refunded = 0;
  let exempt = false;
  for (const p of payments) {
    if (p.status === 'pago') paid += p.amount_cents;
    else if (p.status === 'reembolsado') refunded += p.amount_cents;
    else if (p.status === 'isento') exempt = true;
  }
  if (exempt) return { state: 'isento', paid_cents: paid, due_cents: 0 };
  const due = Math.max(totalCents - paid, 0);
  let state: PaymentState;
  if (totalCents > 0 && paid >= totalCents) state = 'pago';
  else if (paid > 0) state = 'parcial';
  else if (refunded > 0) state = 'reembolsado';
  else state = 'pendente';
  return { state, paid_cents: paid, due_cents: due };
}
