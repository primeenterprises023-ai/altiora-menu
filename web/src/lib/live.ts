// Dados que se mantêm atualizados sozinhos: carrega ao abrir, volta a carregar quando chega um aviso em tempo real,
// quando a internet regressa ou o ecrã volta a ser visto, e periodicamente como reserva (mais depressa se não houver
// ligação em tempo real). Assim o ecrã recupera de quedas de rede sem a pessoa fazer nada.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbort } from './api';
import { Stream } from './stream';

export interface LiveOptions {
  /** Ligação em tempo real (opcional). */
  stream?: Stream | null;
  /** Nomes dos avisos que provocam uma nova leitura (por omissão, todos menos "hello"). */
  ignoreEvents?: readonly string[];
  /** Intervalo de atualização quando NÃO há ligação em tempo real. */
  pollMs?: number;
  /** Intervalo de segurança quando há ligação em tempo real. */
  safetyMs?: number;
  enabled?: boolean;
  /** Muda quando os dados passam a ser outros (ex.: outro código de pedido); recomeça do zero. */
  resetKey?: string;
}

export interface LiveState<T> {
  data: T | undefined;
  error: ApiError | null;
  /** A primeira leitura ainda não terminou. */
  loading: boolean;
  /** Há uma leitura a decorrer (a primeira ou uma atualização). */
  refreshing: boolean;
  /** A ligação em tempo real está ativa. */
  live: boolean;
  /** Momento (Date.now) da última leitura bem sucedida. */
  updatedAt: number | null;
  refresh: () => void;
  /** Altera os dados já carregados (ex.: aplicar a resposta de uma ação sem esperar pela leitura seguinte). */
  mutate: (fn: (current: T | undefined) => T | undefined) => void;
}

export function useLive<T>(load: (signal: AbortSignal) => Promise<T>, opts: LiveOptions = {}): LiveState<T> {
  const { stream = null, pollMs = 6000, safetyMs = 60_000, enabled = true, resetKey = '', ignoreEvents = ['hello', 'open'] } = opts;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;
  const runRef = useRef<() => void>(() => undefined);
  const ignoreRef = useRef(ignoreEvents);
  ignoreRef.current = ignoreEvents;

  useEffect(() => {
    setData(undefined);
    setError(null);
    setLoading(true);
    setUpdatedAt(null);
    if (!enabled) return;

    let stopped = false;
    let inflight: AbortController | null = null;
    let queued = false;
    let timer: number | undefined;
    let debounce: number | undefined;
    let isLive = stream ? stream.live : false;
    // a última leitura falhou: mesmo com o tempo real "ligado" (pode estar preso, sem aviso do navegador), volta a tentar depressa
    let failing = false;
    setLive(isLive);

    const run = async (): Promise<void> => {
      if (stopped) return;
      if (inflight) {
        queued = true;
        return;
      }
      const ctrl = new AbortController();
      inflight = ctrl;
      setRefreshing(true);
      try {
        const result = await loadRef.current(ctrl.signal);
        if (stopped) return;
        setData(result);
        setError(null);
        setUpdatedAt(Date.now());
        failing = false;
      } catch (err) {
        if (stopped || isAbort(err)) return;
        setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Ocorreu um erro inesperado.'));
        if (!failing) {
          failing = true;
          schedule();
        }
      } finally {
        if (inflight === ctrl) inflight = null;
        if (!stopped) {
          setLoading(false);
          setRefreshing(false);
          if (queued) {
            queued = false;
            void run();
          }
        }
      }
    };
    runRef.current = () => void run();

    const kick = (delay = 0) => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void run(), delay);
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => {
          if (!document.hidden) void run();
          schedule();
        },
        isLive && !failing ? safetyMs : pollMs,
      );
    };

    void run();
    schedule();

    const offStream = stream?.subscribe((e) => {
      if (e.type === 'open') {
        kick(0); // (re)ligou: pode ter havido avisos perdidos
        return;
      }
      if (!ignoreRef.current.includes(e.type)) kick(120);
    });
    const offLive = stream?.onLive((v) => {
      isLive = v;
      setLive(v);
      schedule();
    });

    const wake = () => {
      if (document.hidden) return;
      stream?.reconnectNow();
      kick(0);
    };
    // o navegador avisa que ficou sem rede: tenta já uma leitura, que falha de imediato e mostra "Sem ligação"
    const dropped = () => kick(0);
    window.addEventListener('online', wake);
    window.addEventListener('offline', dropped);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(debounce);
      inflight?.abort();
      offStream?.();
      offLive?.();
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', dropped);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      runRef.current = () => undefined;
    };
  }, [stream, enabled, resetKey, pollMs, safetyMs]);

  const refresh = useCallback(() => runRef.current(), []);
  const mutate = useCallback((fn: (current: T | undefined) => T | undefined) => setData((cur) => fn(cur)), []);
  return { data, error, loading, refreshing, live, updatedAt, refresh, mutate };
}
