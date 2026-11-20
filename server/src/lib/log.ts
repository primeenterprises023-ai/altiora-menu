// Registo em linhas JSON. Nunca regista palavras-passe, tokens, cookies nem códigos de pedidos/mesas.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /pass|token|secret|cookie|authorization|public_code|qr_|database_url|session_id|(^|[_-])sid($|[_-])/i;
// endereços com credenciais (postgres://utilizador:palavra-passe@servidor/...) e pares "password=..." dentro de textos
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi;
const KEY_VALUE_SECRET = /\b(password|passwd|pwd|secret|token)=[^\s&;,]+/gi;

/** Remove de um texto livre as credenciais que ele possa conter. */
export function scrub(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1***@').replace(KEY_VALUE_SECRET, '$1=***');
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const e = value as Error & { errno?: unknown; constraint?: unknown };
    return {
      name: e.name,
      message: scrub(String(e.message)).slice(0, 300),
      ...(typeof e.errno === 'string' ? { sqlstate: e.errno } : {}),
      ...(typeof e.constraint === 'string' ? { constraint: e.constraint } : {}),
    };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value && typeof value === 'object') {
    // objetos muito fundos (ou circulares) não são registados: assim nada sensível escapa à filtragem
    if (depth >= 3) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[omitido]' : sanitize(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') {
    const clean = scrub(value);
    return clean.length > 500 ? clean.slice(0, 500) + '…' : clean;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
}

export function createLogger(level: LogLevel, write: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (WEIGHT[lvl] < WEIGHT[level]) return;
    try {
      write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg: scrub(msg), ...(sanitize(fields ?? {}) as object) }));
    } catch {
      // o registo nunca pode fazer falhar um pedido
    }
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
