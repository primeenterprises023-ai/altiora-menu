// Acesso à base de dados.
//
// Regra de ouro: TODO o acesso a dados de restaurantes passa por db.as(contexto, ...).
// Isso abre uma transação, muda para o perfil restrito (SET LOCAL ROLE altiora_<perfil>) e
// indica o contexto (restaurante, utilizador, mesa...). As políticas RLS da base de dados
// fazem o resto — mesmo que o código tenha um erro, não se vê dados de outro restaurante.
//
// db.system(...) corre com o utilizador de ligação (dono das tabelas) e só deve ser usado
// para contas, sessões, migrações e a criação de restaurantes pela plataforma.
import { SQL, type Row, type TxSql } from 'bun';

export type { Row };
export type DbRole = 'public' | 'kitchen' | 'waiter' | 'manager' | 'platform';

const ROLE_SQL: Record<DbRole, string> = {
  public: 'altiora_public',
  kitchen: 'altiora_kitchen',
  waiter: 'altiora_waiter',
  manager: 'altiora_manager',
  platform: 'altiora_platform',
};

export interface DbContext {
  role: DbRole;
  restaurantId?: string | null;
  userId?: string | null;
  tableId?: string | null;
  tableSessionId?: string | null;
  publicCode?: string | null;
  reason?: string | null;
}

export type ContextPatch = Partial<Omit<DbContext, 'role'>>;

export interface Tx {
  <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  unsafe<T = Row>(query: string, params?: unknown[]): Promise<T[]>;
  setContext(patch: ContextPatch): Promise<void>;
  readonly role: DbRole | 'system';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const SETTINGS: Record<keyof ContextPatch, { name: string; check: (v: string) => boolean }> = {
  restaurantId: { name: 'app.restaurant_id', check: (v) => UUID_RE.test(v) },
  userId: { name: 'app.user_id', check: (v) => UUID_RE.test(v) },
  tableId: { name: 'app.table_id', check: (v) => UUID_RE.test(v) },
  tableSessionId: { name: 'app.table_session_id', check: (v) => UUID_RE.test(v) },
  publicCode: { name: 'app.public_code', check: (v) => CODE_RE.test(v) },
  reason: { name: 'app.reason', check: (v) => v.length <= 300 },
};

function wrap(raw: TxSql, role: DbRole | 'system'): Tx {
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => raw(strings, ...values)) as Tx;
  tx.unsafe = (query, params) => raw.unsafe(query, params as unknown[] | undefined);
  tx.setContext = async (patch) => {
    const names: string[] = [];
    const values: string[] = [];
    for (const key of Object.keys(SETTINGS) as Array<keyof ContextPatch>) {
      if (!(key in patch)) continue;
      const v = patch[key];
      const text = v === null || v === undefined ? '' : String(v);
      if (text !== '' && !SETTINGS[key].check(text)) throw new Error(`Contexto inválido: ${key}`);
      names.push(SETTINGS[key].name);
      values.push(text);
    }
    if (!names.length) return;
    // os nomes vêm de uma lista fixa; os valores vão sempre como parâmetros
    const sql = 'SELECT ' + names.map((n, i) => `set_config('${n}', $${i + 1}, true)`).join(', ');
    await raw.unsafe(sql, values);
  };
  Object.defineProperty(tx, 'role', { value: role, enumerable: true });
  return tx;
}

export interface DatabaseOptions {
  max?: number;
  ssl?: 'auto' | 'require' | 'disable';
  /** false = sem instruções preparadas (necessário atrás de um «transaction pooler»). Por omissão, true. */
  prepare?: boolean;
  statementTimeoutMs?: number;
}

/** Impasses (40P01) e falhas de serialização (40001) resolvem-se repetindo a transação. */
const RETRYABLE_SQLSTATE = new Set(['40001', '40P01']);
const MAX_RETRIES = 3;

export class Database {
  readonly sql: SQL;
  private readonly timeoutMs: number;

  constructor(url: string, opts: DatabaseOptions = {}) {
    this.timeoutMs = opts.statementTimeoutMs ?? 10_000;
    const options: Record<string, unknown> = { url, max: opts.max ?? 10, idleTimeout: 30, connectionTimeout: 15, maxLifetime: 1800 };
    if (opts.ssl === 'require') options.tls = true;
    if (opts.ssl === 'disable') options.tls = false;
    if (opts.prepare === false) options.prepare = false;
    this.sql = new SQL(options as never);
  }

  /**
   * Repete a transação se a base de dados a recusar por impasse ou conflito de concorrência.
   * Por isso as funções passadas a system()/as() só podem ter efeitos DENTRO da transação
   * (avisos em tempo real, e-mails, etc. fazem-se depois de terminar).
   */
  private async retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        const code = pgCode(err);
        if (code && RETRYABLE_SQLSTATE.has(code) && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 15 + Math.random() * 45 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  /** Contexto "sistema": utilizador de ligação (sem RLS). Só para contas, sessões, migrações e administração. */
  async system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.retrying(() =>
      this.sql.begin(async (raw) => {
        await raw.unsafe(`SET LOCAL search_path TO altiora, pg_temp; SET LOCAL statement_timeout = ${this.timeoutMs}`);
        return fn(wrap(raw, 'system'));
      }),
    );
  }

  /** Contexto restrito: perfil da base de dados + RLS por restaurante. */
  async as<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const role = ROLE_SQL[ctx.role];
    if (!role) throw new Error(`Perfil desconhecido: ${String(ctx.role)}`);
    return this.retrying(() =>
      this.sql.begin(async (raw) => {
        await raw.unsafe(`SET LOCAL search_path TO altiora, pg_temp; SET LOCAL ROLE ${role}; SET LOCAL statement_timeout = ${this.timeoutMs}`);
        const tx = wrap(raw, ctx.role);
        const { role: _ignored, ...patch } = ctx;
        await tx.setContext(patch);
        await raw.unsafe(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
        return fn(tx);
      }),
    );
  }

  /** Motivo (sem segredos) da última falha de ping(): ajuda a perceber erros de configuração (palavra-passe, SSL, endereço...). */
  lastPingError: string | null = null;

  async ping(): Promise<boolean> {
    try {
      await this.sql.unsafe('SELECT 1');
      this.lastPingError = null;
      return true;
    } catch (err) {
      this.lastPingError = describeDbFailure(err);
      return false;
    }
  }

  /** Verifica, ao arrancar, que as proteções (RLS e perfis) estão realmente em vigor. */
  async selfTest(): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    try {
      await this.system(async (tx) => {
        const tables = await tx<{ relname: string; relrowsecurity: boolean }>`
          SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'altiora' AND c.relkind = 'r'`;
        if (tables.length < 14) problems.push('Faltam tabelas do esquema altiora (as migrações foram aplicadas?).');
        for (const t of tables) if (!t.relrowsecurity) problems.push(`RLS desligado na tabela ${t.relname}.`);
      });
      for (const role of Object.keys(ROLE_SQL) as DbRole[]) {
        await this.as({ role }, async (tx) => {
          const [r] = await tx<{ u: string; bypass: boolean }>`
            SELECT current_user::text AS u,
                   (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass`;
          if (r?.u !== ROLE_SQL[role]) problems.push(`A mudança para o perfil ${ROLE_SQL[role]} não funcionou.`);
          if (r?.bypass) problems.push(`O perfil ${ROLE_SQL[role]} ignora o RLS.`);
        });
      }
      const denied = await this.as({ role: 'manager' }, (tx) => tx`SELECT 1 FROM users LIMIT 1`).then(
        () => false,
        () => true,
      );
      if (!denied) problems.push('O perfil do gerente consegue ler a tabela de utilizadores.');
    } catch (err) {
      problems.push(`Não foi possível verificar a base de dados: ${(err as Error).message}`);
    }
    return { ok: problems.length === 0, problems };
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

/** Descrição curta de uma falha de ligação, para o registo: nunca inclui endereços com palavra-passe. */
export function describeDbFailure(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  let message = e && typeof e.message === 'string' ? e.message : String(err);
  message = message.replace(/(postgres(?:ql)?:\/\/[^:\s/@]*:)[^@\s]*@/gi, '$1***@').replace(/\s+/g, ' ').trim();
  return (code ? `${code}: ` : '') + message.slice(0, 240);
}

/** Código SQLSTATE de um erro da base de dados (ou null). */
export function pgCode(err: unknown): string | null {
  const e = err as { errno?: unknown } | null;
  return e && typeof e.errno === 'string' && /^[0-9A-Z]{5}$/.test(e.errno) ? e.errno : null;
}

export function pgConstraint(err: unknown): string | null {
  const e = err as { constraint?: unknown } | null;
  return e && typeof e.constraint === 'string' ? e.constraint : null;
}

/**
 * Bloqueios de aviso para pôr em fila operações simultâneas sobre a mesma coisa.
 * Libertam-se sozinhos no fim da transação (COMMIT ou ROLLBACK), por isso nunca ficam presos.
 * Quem espera continua depois de o primeiro terminar e já vê o que ele gravou (cada instrução lê dados novos).
 */

/** Envios com a mesma chave de idempotência (no mesmo restaurante) passam um de cada vez: o segundo vê o pedido do primeiro e devolve-o. */
export async function lockIdempotencyKey(tx: Tx, restaurantId: string, key: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${restaurantId}::text || ':' || ${key}::text, 0))`;
}

/** Pedidos novos na mesma mesa passam um de cada vez, para que os limites contra abuso (pedidos por atender, intervalo mínimo) sejam exatos. */
export async function lockTableOrdering(tx: Tx, tableId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${tableId}::text, 1))`;
}

/** Conversões dos tipos devolvidos pelo cliente (bigint e numeric chegam como texto). */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
