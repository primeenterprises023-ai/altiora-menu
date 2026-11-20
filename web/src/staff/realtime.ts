// Ligação em tempo real da equipa: uma só para todos os ecrãs abertos (novo pedido, mudança de estado, pagamento, menu, chamadas de mesa).
import { Stream } from '../lib/stream';

export const STAFF_EVENTS = ['hello', 'order.created', 'order.status', 'order.payment', 'menu.changed', 'waiter.call', 'waiter.call.done'] as const;

let current: { key: string; stream: Stream } | null = null;

/** A ligação da equipa para o restaurante indicado (uma por restaurante; muda quando a pessoa troca de restaurante). */
export function staffStream(restaurantKey: string): Stream {
  if (current && current.key !== restaurantKey) {
    current.stream.dispose();
    current = null;
  }
  if (!current) current = { key: restaurantKey, stream: new Stream('/api/realtime/stream', STAFF_EVENTS) };
  return current.stream;
}

/** Fecha a ligação (fim de sessão): sem sessão não há nada a ouvir. */
export function closeStaffStream(): void {
  current?.stream.dispose();
  current = null;
}
