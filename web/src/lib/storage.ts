// Armazenamento do navegador, à prova de falhas: em separadores privados ou com dados bloqueados pode não existir.
// Só se guardam comodidades (carrinho, preferências); nunca algo de que a aplicação dependa para funcionar.

type Kind = 'local' | 'session';
const cache: Partial<Record<Kind, Storage | null>> = {};

function pick(kind: Kind): Storage | null {
  if (kind in cache) return cache[kind] ?? null;
  let s: Storage | null = null;
  try {
    s = kind === 'local' ? window.localStorage : window.sessionStorage;
    const probe = '__altiora_probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
  } catch {
    s = null;
  }
  cache[kind] = s;
  return s;
}

function make(kind: Kind) {
  return {
    get(key: string): string | null {
      try {
        return pick(kind)?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        pick(kind)?.setItem(key, value);
      } catch {
        /* sem espaço ou bloqueado: ignora */
      }
    },
    remove(key: string): void {
      try {
        pick(kind)?.removeItem(key);
      } catch {
        /* ignora */
      }
    },
    getJson<T>(key: string): T | null {
      const raw = this.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    setJson(key: string, value: unknown): void {
      try {
        this.set(key, JSON.stringify(value));
      } catch {
        /* ignora */
      }
    },
  };
}

export const local = make('local');
export const session = make('session');
