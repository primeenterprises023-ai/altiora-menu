// Distribuição de eventos em tempo real dentro do processo (uma só instância).
// Os eventos são só um "aviso": os painéis voltam a pedir os dados à API. Se um aviso se perder,
// nenhum pedido se perde — está na base de dados — e os painéis também atualizam periodicamente.

export type HubEvent = { type: string } & Record<string, unknown>;
export type Listener = (event: HubEvent) => void;

export class Hub {
  private readonly restaurants = new Map<string, Set<Listener>>();
  private readonly orders = new Map<string, Set<Listener>>();
  private connections = 0;

  private add(map: Map<string, Set<Listener>>, key: string, fn: Listener): () => void {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(fn);
    this.connections++;
    return () => {
      const s = map.get(key);
      if (s?.delete(fn)) this.connections--;
      if (s && s.size === 0) map.delete(key);
    };
  }

  private emit(map: Map<string, Set<Listener>>, key: string, event: HubEvent): void {
    const set = map.get(key);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch {
        // um ouvinte com problemas não deve afetar os outros
      }
    }
  }

  subscribeRestaurant(restaurantId: string, fn: Listener): () => void {
    return this.add(this.restaurants, restaurantId, fn);
  }
  subscribeOrder(publicCode: string, fn: Listener): () => void {
    return this.add(this.orders, publicCode, fn);
  }
  publishRestaurant(restaurantId: string, event: HubEvent): void {
    this.emit(this.restaurants, restaurantId, event);
  }
  publishOrder(publicCode: string, event: HubEvent): void {
    this.emit(this.orders, publicCode, event);
  }
  get connectionCount(): number {
    return this.connections;
  }

  private readonly slots = new Map<string, number>();

  /** Limita ligações abertas em simultâneo por chave (ex.: por IP). Devolve a função para libertar a vaga, ou null se estiver cheio. */
  acquireSlot(key: string, max: number): (() => void) | null {
    const n = this.slots.get(key) ?? 0;
    if (n >= max) return null;
    this.slots.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = (this.slots.get(key) ?? 1) - 1;
      if (cur <= 0) this.slots.delete(key);
      else this.slots.set(key, cur);
    };
  }
}
