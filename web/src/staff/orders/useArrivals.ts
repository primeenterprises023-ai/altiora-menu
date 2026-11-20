import { useEffect, useRef, useState } from 'react';
import type { OrderView } from '../../../../shared/types';

/**
 * Deteta pedidos que passaram a cumprir uma condição (ex.: "novo" na cozinha, "pronto" no empregado) depois da primeira leitura.
 * Devolve os identificadores a destacar durante alguns segundos e chama `onArrive` com os que acabaram de chegar.
 */
export function useArrivals(
  orders: OrderView[] | undefined,
  match: (o: OrderView) => boolean,
  onArrive: (arrived: OrderView[]) => void,
  freshMs = 9000,
): ReadonlySet<string> {
  const before = useRef<Set<string> | null>(null);
  const matchRef = useRef(match);
  const arriveRef = useRef(onArrive);
  matchRef.current = match;
  arriveRef.current = onArrive;
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!orders) return;
    const now = orders.filter(matchRef.current);
    const nowIds = new Set(now.map((o) => o.id));
    const previous = before.current;
    before.current = nowIds;
    if (previous === null) return; // primeira leitura: só serve de ponto de partida
    const arrived = now.filter((o) => !previous.has(o.id));
    if (arrived.length === 0) return;
    arriveRef.current(arrived);
    const ids = arrived.map((o) => o.id);
    setFresh((cur) => new Set([...cur, ...ids]));
    const t = window.setTimeout(
      () =>
        setFresh((cur) => {
          const next = new Set(cur);
          for (const id of ids) next.delete(id);
          return next;
        }),
      freshMs,
    );
    return () => window.clearTimeout(t);
  }, [orders, freshMs]);

  return fresh;
}
