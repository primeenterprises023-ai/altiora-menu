// «Chamar o garçom»: as mesas que estão a chamar, sempre atualizadas (aviso em tempo real + leitura periódica de reserva).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WaiterCallView } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { useLive, type LiveState } from '../../lib/live';
import { useToast } from '../../ui/Toast';
import { calls as callsApi } from '../data';
import { useStaffStream } from '../hooks';

export interface CallsData {
  calls: WaiterCallView[];
  /** Diferença entre o relógio do servidor e o deste aparelho (para os "há 2 min" estarem certos). */
  skewMs: number;
}

/**
 * Lê as chamadas abertas e avisa (`onArrive`) quando chega uma nova depois da primeira leitura.
 * `attend` marca uma chamada como atendida: a resposta é aplicada logo e, se outra pessoa já a tinha atendido, diz-se com clareza.
 */
export function useWaiterCalls(onArrive: (arrived: WaiterCallView[]) => void) {
  const stream = useStaffStream();
  const toast = useToast();
  const list: LiveState<CallsData> = useLive<CallsData>(
    async (signal) => {
      const r = await callsApi.list(signal);
      return { calls: r.calls, skewMs: Date.parse(r.server_time) - Date.now() };
    },
    { stream, pollMs: 6000, safetyMs: 30_000 },
  );

  const known = useRef<Set<string> | null>(null);
  const arriveRef = useRef(onArrive);
  arriveRef.current = onArrive;
  const open = list.data?.calls;
  useEffect(() => {
    if (!open) return;
    const ids = new Set(open.map((c) => c.id));
    const before = known.current;
    known.current = ids;
    if (before === null) return; // primeira leitura: só serve de ponto de partida
    const arrived = open.filter((c) => !before.has(c.id));
    if (arrived.length > 0) arriveRef.current(arrived);
  }, [open]);

  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const running = useRef(new Set<string>());
  const { mutate, refresh } = list;
  const attend = useCallback(
    async (call: WaiterCallView): Promise<void> => {
      if (running.current.has(call.id)) return;
      running.current.add(call.id);
      setBusy(new Set(running.current));
      try {
        await callsApi.attend(call.id);
        mutate((cur) => (cur ? { ...cur, calls: cur.calls.filter((c) => c.id !== call.id) } : cur));
        refresh();
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'CALL_ALREADY_DONE' || err.code === 'CALL_NOT_FOUND')) {
          toast.show(`A chamada da mesa ${call.table_number} já tinha sido tratada.`);
          mutate((cur) => (cur ? { ...cur, calls: cur.calls.filter((c) => c.id !== call.id) } : cur));
          refresh();
        } else {
          toast.show(errorText(err), 'danger');
        }
      } finally {
        running.current.delete(call.id);
        setBusy(new Set(running.current));
      }
    },
    [mutate, refresh, toast],
  );

  return { list, calls: open ?? [], skewMs: list.data?.skewMs ?? 0, busy, attend };
}
