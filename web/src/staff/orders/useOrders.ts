import { useCallback, useRef, useState } from 'react';
import { ACTIVE_STATUSES, type OrderStatus } from '../../../../shared/status';
import type { OrderView } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { useLive, type LiveState } from '../../lib/live';
import { useToast } from '../../ui/Toast';
import { orders as ordersApi, type OrderQuery } from '../data';
import { useStaffStream } from '../hooks';

export interface OrdersData {
  orders: OrderView[];
  /** Diferença entre o relógio do servidor e o deste aparelho (para os "há 5 min" estarem certos mesmo com a hora mal acertada). */
  skewMs: number;
  /** Havia mais pedidos do que os que foram trazidos. */
  truncated: boolean;
}

export const ACTIVE_LIMIT = 200;

export function useOrders(query: OrderQuery, opts: { enabled?: boolean; resetKey?: string; pollMs?: number } = {}): LiveState<OrdersData> {
  const stream = useStaffStream();
  const limit = query.limit ?? ACTIVE_LIMIT;
  return useLive<OrdersData>(
    async (signal) => {
      const r = await ordersApi.list({ ...query, limit }, signal);
      return { orders: r.orders, skewMs: Date.parse(r.server_time) - Date.now(), truncated: r.orders.length >= limit };
    },
    { stream, enabled: opts.enabled, resetKey: opts.resetKey, pollMs: opts.pollMs ?? 5000, safetyMs: 45_000 },
  );
}

/** Pedidos em curso (novo, em preparação, pronto), do mais antigo para o mais recente. */
export const useActiveOrders = (enabled = true) => useOrders({ scope: 'active' }, { enabled });

const isActive = (s: OrderStatus) => (ACTIVE_STATUSES as readonly string[]).includes(s);

/**
 * Mudar o estado de um pedido a partir de uma lista de pedidos em curso: um clique de cada vez por pedido, resposta aplicada já
 * e mensagem clara se outra pessoa mexeu primeiro.
 */
export function useOrderActions(list: LiveState<OrdersData>) {
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const running = useRef(new Set<string>());
  const { mutate, refresh } = list;

  const run = useCallback(
    async (order: OrderView, to: OrderStatus, reason?: string): Promise<boolean> => {
      if (running.current.has(order.id)) return false;
      running.current.add(order.id);
      setBusy(new Set(running.current));
      try {
        const r = await ordersApi.changeStatus(order.id, { to, from: order.status, ...(reason ? { reason } : {}) });
        mutate((cur) =>
          cur ? { ...cur, orders: cur.orders.flatMap((o) => (o.id !== r.order.id ? [o] : isActive(r.order.status) ? [r.order] : [])) } : cur,
        );
        refresh();
        return true;
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'STATE_CONFLICT' || err.code === 'ORDER_NOT_FOUND')) {
          toast.show('Este pedido já foi alterado por outra pessoa. A lista foi atualizada.', 'danger');
        } else {
          toast.show(errorText(err), 'danger');
        }
        refresh();
        return false;
      } finally {
        running.current.delete(order.id);
        setBusy(new Set(running.current));
      }
    },
    [mutate, refresh, toast],
  );
  return { busy, run };
}
