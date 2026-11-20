import type { OrderView } from '../../../../shared/types';

export type Urgency = 'ok' | 'warn' | 'late';

/** Há quanto tempo o pedido espera (desde que foi feito; se já está pronto, desde que ficou pronto), com a hora do servidor como referência. */
export function ageMs(order: OrderView, now: number, skewMs: number): number {
  const since = order.status === 'pronto' && order.ready_at ? order.ready_at : order.created_at;
  return Math.max(0, now + skewMs - Date.parse(since));
}

const LIMITS: Record<string, [number, number]> = {
  novo: [5, 10],
  em_preparacao: [15, 25],
  pronto: [3, 8],
};

/** Discreto: serve para destacar o que está à espera há muito tempo. O texto "há X min" diz sempre o tempo; a cor só reforça. */
export function urgency(order: OrderView, now: number, skewMs: number): Urgency {
  const limits = LIMITS[order.status];
  if (!limits) return 'ok';
  const min = ageMs(order, now, skewMs) / 60_000;
  if (min >= limits[1]) return 'late';
  if (min >= limits[0]) return 'warn';
  return 'ok';
}
