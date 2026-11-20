import { useEffect, useRef, useState } from 'react';
import type { Stream, StreamEvent } from '../lib/stream';
import { staffStream } from './realtime';
import { useSession } from './session';

export function useStaffStream(): Stream {
  const { user } = useSession();
  return staffStream(`${user?.id ?? ''}:${user?.restaurant?.id ?? ''}`);
}

/** Recebe cada aviso em tempo real (além da atualização automática dos dados). */
export function useStaffEvents(handler: (e: StreamEvent) => void): void {
  const stream = useStaffStream();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => stream.subscribe((e) => ref.current(e)), [stream]);
}

/** O momento atual, atualizado de tempos a tempos (para os "há 5 min" se manterem certos sem recarregar dados). */
export function useNow(everyMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    const wake = () => setNow(Date.now());
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [everyMs]);
  return now;
}

/** Título do separador do navegador (ex.: "(3) Cozinha"), útil para ver novidades com o painel noutro separador. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}
