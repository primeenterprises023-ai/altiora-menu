// Ligação em tempo real (Server-Sent Events) com reconexão automática.
// Os eventos são apenas avisos ("algo mudou"): quem os recebe volta a pedir os dados à API.
// Por isso, se um aviso se perder, nada se perde — e há sempre a atualização periódica como reserva.

export interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
}

type Listener = (e: StreamEvent) => void;

export class Stream {
  private es: EventSource | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly liveListeners = new Set<(live: boolean) => void>();
  private retryTimer: number | null = null;
  private closeTimer: number | null = null;
  private attempt = 0;
  private _live = false;
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly names: readonly string[],
  ) {}

  get live(): boolean {
    return this._live;
  }

  /** Regista um ouvinte; a ligação abre com o primeiro e fecha (após uma pausa curta) quando já não há ninguém. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.listeners.size === 1) this.connect();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.closeTimer === null) {
        this.closeTimer = window.setTimeout(() => {
          this.closeTimer = null;
          if (this.listeners.size === 0) this.disconnect();
        }, 1500);
      }
    };
  }

  onLive(fn: (live: boolean) => void): () => void {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  /** Tenta voltar a ligar já (ex.: o aparelho voltou a ter internet). */
  reconnectNow(): void {
    if (this.disposed || this.listeners.size === 0) return;
    if (!this.es || this.es.readyState === 2) this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.listeners.clear();
    this.liveListeners.clear();
  }

  private setLive(v: boolean): void {
    if (this._live === v) return;
    this._live = v;
    this.liveListeners.forEach((l) => l(v));
  }

  private emit(e: StreamEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* um ouvinte com problemas não afeta os outros */
      }
    }
  }

  private connect(): void {
    if (this.disposed || typeof EventSource === 'undefined') return;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.es?.close();
    const es = new EventSource(this.url);
    this.es = es;
    es.onopen = () => {
      this.attempt = 0;
      this.setLive(true);
      this.emit({ type: 'open', data: {} });
    };
    for (const name of this.names) {
      es.addEventListener(name, (ev) => {
        let data: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse((ev as MessageEvent<string>).data);
          if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
        } catch {
          /* aviso sem dados: serve na mesma */
        }
        this.emit({ type: name, data });
      });
    }
    es.onerror = () => {
      this.setLive(false);
      // se o navegador desistiu (ex.: o servidor respondeu com erro), voltamos a tentar nós, com pausas crescentes
      if (es.readyState === 2) {
        es.close();
        if (this.es === es) this.es = null;
        if (!this.disposed && this.listeners.size > 0 && this.retryTimer === null) {
          const delay = Math.min(30_000, 1500 * 2 ** Math.min(this.attempt, 5)) + Math.random() * 500;
          this.attempt++;
          this.retryTimer = window.setTimeout(() => {
            this.retryTimer = null;
            this.connect();
          }, delay);
        }
      }
    };
  }

  private disconnect(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.closeTimer !== null) window.clearTimeout(this.closeTimer);
    this.retryTimer = null;
    this.closeTimer = null;
    this.es?.close();
    this.es = null;
    this.setLive(false);
  }
}
