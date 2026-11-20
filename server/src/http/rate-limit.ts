// Limitação de pedidos em memória (uma só instância do servidor).
// Se o serviço passar a correr em várias instâncias, estes contadores devem passar para um armazenamento partilhado.

interface Bucket {
  tokens: number;
  ts: number;
}

export interface HitResult {
  ok: boolean;
  retryAfterSec: number;
}

/** "Balde de fichas": permite `max` pedidos por janela de `windowMs`, repostos de forma contínua. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly enabled = true,
    private readonly maxKeys = 100_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  hit(key: string, max: number, windowMs: number): HitResult {
    if (!this.enabled) return { ok: true, retryAfterSec: 0 };
    const now = this.now();
    const rate = max / windowMs;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      b = { tokens: max, ts: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(max, b.tokens + (now - b.ts) * rate);
      b.ts = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
  }

  /** Remove baldes parados há muito tempo (e, em último caso, os mais antigos). */
  prune(now = this.now()): void {
    for (const [k, b] of this.buckets) if (now - b.ts > 10 * 60_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) {
      let n = Math.ceil(this.maxKeys * 0.1);
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        if (--n <= 0) break;
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

interface Failures {
  count: number;
  first: number;
  last: number;
}

/** Bloqueia temporariamente após demasiadas tentativas falhadas de início de sessão. */
export class LoginThrottle {
  private readonly map = new Map<string, Failures>();

  constructor(
    private readonly enabled = true,
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** Devolve os segundos de espera restantes (0 = pode tentar). */
  check(key: string, maxFailures: number): number {
    if (!this.enabled) return 0;
    const f = this.map.get(key);
    if (!f) return 0;
    const now = this.now();
    if (now - f.last > this.windowMs) {
      this.map.delete(key);
      return 0;
    }
    if (f.count >= maxFailures) return Math.max(1, Math.ceil((f.last + this.windowMs - now) / 1000));
    return 0;
  }

  fail(key: string): void {
    if (!this.enabled) return;
    const now = this.now();
    const f = this.map.get(key);
    if (!f || now - f.last > this.windowMs) this.map.set(key, { count: 1, first: now, last: now });
    else {
      f.count += 1;
      f.last = now;
    }
    if (this.map.size > 50_000) {
      for (const [k, v] of this.map) if (now - v.last > this.windowMs) this.map.delete(k);
    }
  }

  success(key: string): void {
    this.map.delete(key);
  }
}
