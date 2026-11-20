// Respostas Server-Sent Events (SSE): o servidor envia avisos ao navegador numa ligação aberta.
import type { HubEvent } from './hub';

export interface SseOptions {
  /** Regista o ouvinte e devolve a função para o remover. */
  subscribe: (send: (event: HubEvent) => void) => () => void;
  /** Evento inicial enviado logo após a ligação. */
  hello?: HubEvent;
  heartbeatMs?: number;
  /** Fecha a ligação passado este tempo; o navegador volta a ligar-se sozinho. */
  maxLifetimeMs?: number;
  onClose?: () => void;
}

const encoder = new TextEncoder();

export function sseResponse(req: Request, opts: SseOptions): Response {
  let cleanup: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let seq = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        cleanup?.();
        opts.onClose?.();
        try {
          controller.close();
        } catch {
          // já fechado
        }
      };
      const write = (text: string) => {
        if (closed) return;
        // cliente lento: se a fila encher, desligamos (o navegador volta a ligar-se)
        if ((controller.desiredSize ?? 1) < -64) return close();
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const send = (event: HubEvent) => write(`id: ${++seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

      write('retry: 3000\n\n');
      if (opts.hello) send(opts.hello);
      cleanup = opts.subscribe(send);
      heartbeat = setInterval(() => write(': ping\n\n'), opts.heartbeatMs ?? 15_000);
      if (opts.maxLifetimeMs) lifetime = setTimeout(close, opts.maxLifetimeMs);
      req.signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (lifetime) clearTimeout(lifetime);
      cleanup?.();
      opts.onClose?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
