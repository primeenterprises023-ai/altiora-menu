// Configuração lida das variáveis de ambiente (nunca do código).
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super('Configuração inválida:\n - ' + problems.join('\n - '));
    this.name = 'ConfigError';
  }
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes', 'sim'].includes(v.trim().toLowerCase())));

const intRange = (min: number, max: number, def: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intRange(1, 65535, 3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL é obrigatório (endereço da base de dados PostgreSQL).' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL deve começar por postgres:// ou postgresql://'),
  DATABASE_SSL: z.enum(['auto', 'require', 'disable']).default('auto'),
  DATABASE_POOL_MAX: intRange(1, 50, 10),
  DATABASE_PREPARE: bool(true),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY_HOPS: intRange(0, 5, 1),
  AUTO_MIGRATE: bool(true),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(10).max(128).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().max(120).default('Administrador Altiora'),
  SESSION_IDLE_HOURS: intRange(1, 168, 12),
  SESSION_MAX_DAYS: intRange(1, 90, 14),
  TABLE_SESSION_MINUTES: intRange(10, 1440, 240),
  COOKIE_SECURE: z.string().optional(),
  SCRYPT_LOG_N: intRange(10, 17, 15),
  RATE_LIMIT_ENABLED: bool(true),
  MAX_PENDING_ORDERS_PER_TABLE: intRange(1, 100, 8),
  MIN_SECONDS_BETWEEN_ORDERS: intRange(0, 60, 3),
  ASSET_QUOTA_MB: intRange(5, 5000, 80),
  DEMO_RESTAURANT_SLUG: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).default('demo'),
  SEED_SHOWCASE: bool(false),
  DEMO_MEDIA_DIR: z.string().default('./scripts/demo-media/assets'),
  COMMERCIAL_EMAIL: z.string().email().optional(),
  COMMERCIAL_PHONE: z.string().max(40).optional(),
  COMMERCIAL_WHATSAPP: z.string().max(40).optional(),
  COMMERCIAL_ADDRESS: z.string().max(200).optional(),
  WEB_DIR: z.string().default('./dist/web'),
  MIGRATIONS_DIR: z.string().default('./db/migrations'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** Nomes de todas as variáveis de ambiente que o servidor lê (usado para garantir que .env.example e render.yaml não ficam desatualizados). */
export const ENV_KEYS: readonly string[] = Object.keys(EnvSchema.shape);

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  databaseSsl: 'auto' | 'require' | 'disable';
  databasePoolMax: number;
  /** false só para ligações através de um «transaction pooler» (porta 6543 do Supabase), que não aceita instruções preparadas. */
  databasePrepare: boolean;
  publicBaseUrl: string;
  allowedOrigins: string[];
  trustProxyHops: number;
  autoMigrate: boolean;
  bootstrapAdmin: { email: string; password: string; name: string } | null;
  /** Só um de BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD está definido (a conta inicial não é criada). */
  bootstrapIncomplete: boolean;
  sessionIdleHours: number;
  sessionMaxDays: number;
  tableSessionMinutes: number;
  /** Espaço máximo de fotografias e modelos 3D por restaurante. */
  assetQuotaBytes: number;
  /** Slug do restaurante de demonstração mostrado na página comercial (se existir). */
  demoSlug: string;
  /** Ao arrancar, cria o restaurante-montra «Casa Aurora» se ainda não existir (SEED_SHOWCASE=true). */
  seedShowcase: boolean;
  /** Pasta com as fotografias e os modelos 3D do restaurante-montra. */
  demoMediaDir: string;
  /** Contactos comerciais da Altiora Grupo, mostrados na página comercial (só os que estiverem definidos). */
  commercial: { email: string | null; phone: string | null; whatsapp: string | null; address: string | null };
  cookieSecure: boolean;
  scryptLogN: number;
  rateLimitEnabled: boolean;
  webDir: string;
  migrationsDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  version: string;
  limits: {
    maxPendingOrdersPerTable: number;
    minSecondsBetweenOrders: number;
    maxOrderLines: number;
    maxOrderQuantity: number;
    maxOrderTotalCents: number;
  };
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/** Máquina local ou rede privada (onde uma ligação sem cifra à base de dados é aceitável). */
function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return true;
  if (!h.includes('.')) return true; // nome interno (Docker, rede privada do alojamento)
  if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.lan')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/**
 * Em produção, a base de dados quase sempre está noutro servidor, e a palavra-passe e os pedidos viajam pela internet.
 * Devolve um aviso se a ligação a um servidor remoto não for obrigatoriamente cifrada (ou null se estiver tudo bem).
 */
export function databaseTransportWarning(databaseUrl: string, ssl: 'auto' | 'require' | 'disable'): string | null {
  if (ssl === 'require') return null;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (isLocalOrPrivateHost(url.hostname)) return null;
  const mode = (url.searchParams.get('sslmode') ?? '').toLowerCase();
  if (ssl === 'auto' && ['require', 'verify-ca', 'verify-full'].includes(mode)) return null;
  return `A ligação à base de dados (${url.hostname}) pode não estar cifrada. Defina DATABASE_SSL=require nas variáveis de ambiente.`;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== '') cleaned[k] = v.trim();
  // No Render, o próprio serviço conhece o seu endereço público (https://nome.onrender.com): evita um passo manual.
  // Um PUBLIC_BASE_URL definido de propósito (por exemplo, o domínio próprio do restaurante) tem sempre prioridade.
  if (!cleaned.PUBLIC_BASE_URL && cleaned.RENDER_EXTERNAL_URL) cleaned.PUBLIC_BASE_URL = cleaned.RENDER_EXTERNAL_URL;

  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'configuração'}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];
  const isProd = e.NODE_ENV === 'production';

  const publicBaseUrl = originOf(e.PUBLIC_BASE_URL);
  if (isProd && !publicBaseUrl.startsWith('https://')) {
    problems.push('PUBLIC_BASE_URL deve começar por https:// em produção.');
  }
  const allowedOrigins: string[] = [];
  for (const raw of e.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      allowedOrigins.push(originOf(raw));
    } catch {
      problems.push(`ALLOWED_ORIGINS contém um endereço inválido: ${raw}`);
    }
  }
  // Só funcionam em conjunto. Com apenas um deles, a conta não é criada, mas o servidor arranca na mesma (e avisa): assim,
  // quem apaga a palavra-passe depois do primeiro acesso (como se recomenda) não deixa o serviço parado.
  const bootstrapIncomplete = Boolean(e.BOOTSTRAP_ADMIN_EMAIL) !== Boolean(e.BOOTSTRAP_ADMIN_PASSWORD);
  if (problems.length) throw new ConfigError(problems);

  const cookieSecure =
    e.COOKIE_SECURE === undefined ? isProd : ['true', '1', 'yes', 'sim'].includes(e.COOKIE_SECURE.trim().toLowerCase());

  return {
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    databasePrepare: e.DATABASE_PREPARE,
    publicBaseUrl,
    allowedOrigins,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    autoMigrate: e.AUTO_MIGRATE,
    bootstrapAdmin:
      e.BOOTSTRAP_ADMIN_EMAIL && e.BOOTSTRAP_ADMIN_PASSWORD
        ? { email: e.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(), password: e.BOOTSTRAP_ADMIN_PASSWORD, name: e.BOOTSTRAP_ADMIN_NAME }
        : null,
    bootstrapIncomplete,
    sessionIdleHours: e.SESSION_IDLE_HOURS,
    sessionMaxDays: e.SESSION_MAX_DAYS,
    tableSessionMinutes: e.TABLE_SESSION_MINUTES,
    assetQuotaBytes: e.ASSET_QUOTA_MB * 1024 * 1024,
    demoSlug: e.DEMO_RESTAURANT_SLUG,
    seedShowcase: e.SEED_SHOWCASE,
    demoMediaDir: e.DEMO_MEDIA_DIR,
    commercial: {
      email: e.COMMERCIAL_EMAIL ?? null,
      phone: e.COMMERCIAL_PHONE?.trim() || null,
      whatsapp: e.COMMERCIAL_WHATSAPP ? e.COMMERCIAL_WHATSAPP.replace(/\D/g, '') || null : null,
      address: e.COMMERCIAL_ADDRESS?.trim() || null,
    },
    cookieSecure,
    scryptLogN: e.SCRYPT_LOG_N,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    webDir: e.WEB_DIR,
    migrationsDir: e.MIGRATIONS_DIR,
    logLevel: e.LOG_LEVEL,
    version: process.env.APP_VERSION ?? '0.1.0',
    limits: {
      maxPendingOrdersPerTable: e.MAX_PENDING_ORDERS_PER_TABLE,
      minSecondsBetweenOrders: e.MIN_SECONDS_BETWEEN_ORDERS,
      maxOrderLines: 40,
      maxOrderQuantity: 100,
      maxOrderTotalCents: 1_000_000_000_000,
    },
  };
}
