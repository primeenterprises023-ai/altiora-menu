// Utilitários de teste: cada ficheiro de testes cria a sua própria base de dados (migrada com o executor real),
// arranca a aplicação em memória (sem rede) e usa "clientes" que guardam cookies como um navegador.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SQL } from 'bun';
import { createApp, type App } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { loadConfig, type Config } from '../src/config';
import { Database } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { buildDeps } from '../src/deps';
import type { Deps } from '../src/http/types';
import { silentLogger, type Logger } from '../src/lib/log';
import { randomToken } from '../src/lib/crypto';
import type { StaffRole } from '../../shared/status';

export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
export const PASSWORD = 'Senha-Teste-12345';
export const ORIGIN = 'http://app.test';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  res: Response;
}

export class Client {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: App,
    readonly ip = '10.0.0.1',
    private readonly origin = ORIGIN,
  ) {}

  async request<T = any>(
    method: string,
    path: string,
    opts: { json?: unknown; body?: string; headers?: Record<string, string>; noOrigin?: boolean; keepOpen?: boolean; signal?: AbortSignal } = {},
  ): Promise<ApiResponse<T>> {
    const headers = new Headers(opts.headers);
    if (opts.json !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (method !== 'GET' && method !== 'HEAD' && !opts.noOrigin && !headers.has('origin')) headers.set('origin', this.origin);
    const req = new Request(this.origin + path, {
      method,
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
      signal: opts.signal,
    });
    const res = await this.app.fetch(req, { ip: this.ip });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
      if (value === '' || (maxAge && Number(maxAge.split('=')[1]) === 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    if (opts.keepOpen) return { status: res.status, body: null as T, headers: res.headers, res };
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* texto simples (ex.: HTML) */
    }
    return { status: res.status, body, headers: res.headers, res };
  }

  get = <T = any>(path: string, opts = {}) => this.request<T>('GET', path, opts);
  post = <T = any>(path: string, json?: unknown, opts: Record<string, unknown> = {}) => this.request<T>('POST', path, { json, ...opts });
  patch = <T = any>(path: string, json?: unknown, opts: Record<string, unknown> = {}) => this.request<T>('PATCH', path, { json, ...opts });
  delete = <T = any>(path: string, opts = {}) => this.request<T>('DELETE', path, opts);
}

export interface TestApp {
  config: Config;
  db: Database;
  deps: Deps;
  app: App;
  dbName: string;
  anon(ip?: string): Client;
  login(email: string, password?: string, ip?: string): Promise<Client>;
  close(): Promise<void>;
}

export interface StartOptions {
  env?: Record<string, string>;
  log?: Logger;
}

export async function startTestApp(opts: StartOptions = {}): Promise<TestApp> {
  const dbName = `t_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const admin = new SQL({ url: ADMIN_URL, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.close();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    DATABASE_SSL: 'disable',
    PUBLIC_BASE_URL: ORIGIN,
    SCRYPT_LOG_N: '10',
    RATE_LIMIT_ENABLED: 'false',
    MIN_SECONDS_BETWEEN_ORDERS: '0',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
    DATABASE_POOL_MAX: '8',
    MIGRATIONS_DIR: join(import.meta.dir, '../../db/migrations'),
    WEB_DIR: join(import.meta.dir, 'fixtures/web'),
    ...opts.env,
  });
  const db = new Database(url, { max: 8, ssl: 'disable' });
  await runMigrations(db.sql, config.migrationsDir);
  const deps = buildDeps(config, db, opts.log ?? silentLogger);
  const app = createApp(deps);

  const t: TestApp = {
    config,
    db,
    deps,
    app,
    dbName,
    anon: (ip) => new Client(app, ip),
    async login(email, password = PASSWORD, ip) {
      const c = new Client(app, ip);
      const r = await c.post('/api/auth/login', { email, password });
      if (r.status !== 200) throw new Error(`login falhou para ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return c;
    },
    async close() {
      await db.close();
      const a = new SQL({ url: ADMIN_URL, max: 1 });
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
  return t;
}

// --- dados de teste ------------------------------------------------------------------------------
const hashCache = new Map<string, string>();
async function hash(password: string): Promise<string> {
  let h = hashCache.get(password);
  if (!h) hashCache.set(password, (h = await hashPassword(password, 10)));
  return h;
}

export async function seedPlatformAdmin(t: TestApp, email = 'admin@altiora.test', mustChange = false): Promise<string> {
  const h = await hash(PASSWORD);
  return t.db.system(async (tx) => (await tx<{ id: string }>`
    INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password)
    VALUES (${email}, 'Admin Altiora', ${h}, true, ${mustChange}) RETURNING id`)[0]!.id);
}

export async function seedRestaurant(t: TestApp, name = 'Restaurante Teste', extra: { slug?: string; timezone?: string; feeBps?: number; status?: string; plan?: string } = {}): Promise<string> {
  const slug = extra.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  return t.db.system(async (tx) => {
    const [r] = await tx<{ id: string }>`
      INSERT INTO restaurants (name, slug, timezone, service_fee_bps, status)
      VALUES (${name}, ${slug}, ${extra.timezone ?? 'Africa/Luanda'}, ${extra.feeBps ?? 0}, ${extra.status ?? 'ativo'}) RETURNING id`;
    // por omissão os testes usam o plano com todas as funcionalidades
    await tx`INSERT INTO subscriptions (restaurant_id, plan_code) VALUES (${r!.id}, ${extra.plan ?? 'premium'})`;
    return r!.id;
  });
}

export async function seedUser(
  t: TestApp,
  p: { restaurantId: string; email: string; role: StaffRole; name?: string; password?: string; mustChange?: boolean },
): Promise<string> {
  const h = await hash(p.password ?? PASSWORD);
  return t.db.system(async (tx) => {
    const [u] = await tx<{ id: string }>`
      INSERT INTO users (email, name, password_hash, must_change_password)
      VALUES (${p.email}, ${p.name ?? p.email.split('@')[0]}, ${h}, ${p.mustChange ?? false}) RETURNING id`;
    await tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${p.restaurantId}, ${u!.id}, ${p.role})`;
    return u!.id;
  });
}

export interface SeededTable {
  id: string;
  number: number;
  token: string;
}

export async function seedTable(t: TestApp, restaurantId: string, number: number, label: string | null = null): Promise<SeededTable> {
  const token = randomToken(16);
  const id = await t.db.system(async (tx) => (await tx<{ id: string }>`
    INSERT INTO restaurant_tables (restaurant_id, table_number, label, qr_token)
    VALUES (${restaurantId}, ${number}, ${label}, ${token}) RETURNING id`)[0]!.id);
  return { id, number, token };
}

export interface SeededMenu {
  categoryId: string;
  hiddenCategoryId: string;
  moamba: { id: string; price: number };
  sumo: { id: string; price: number };
  esgotado: { id: string; price: number };
  inativo: { id: string; price: number };
  escondido: { id: string; price: number };
  extraOvo: { id: string; price: number };
  extraInativo: { id: string };
}

/** Menu de exemplo (preços em cêntimos: 4500 Kz = 450000). */
export async function seedMenu(t: TestApp, restaurantId: string): Promise<SeededMenu> {
  return t.db.system(async (tx) => {
    const cat = async (name: string, active = true) =>
      (await tx<{ id: string }>`INSERT INTO categories (restaurant_id, name, active) VALUES (${restaurantId}, ${name}, ${active}) RETURNING id`)[0]!.id;
    const item = async (categoryId: string, name: string, price: number, available = true, active = true) =>
      (await tx<{ id: string }>`
        INSERT INTO menu_items (restaurant_id, category_id, name, price_cents, available, active)
        VALUES (${restaurantId}, ${categoryId}, ${name}, ${price}, ${available}, ${active}) RETURNING id`)[0]!.id;
    const categoryId = await cat('Pratos');
    const hiddenCategoryId = await cat('Categoria escondida', false);
    const moamba = await item(categoryId, 'Muamba de galinha', 450000);
    const sumo = await item(categoryId, 'Sumo natural', 120000);
    const esgotado = await item(categoryId, 'Calulu (esgotado)', 600000, false);
    const inativo = await item(categoryId, 'Prato desativado', 100000, true, false);
    const escondido = await item(hiddenCategoryId, 'Prato da categoria escondida', 100000);
    const opt = async (itemId: string, name: string, delta: number, active = true) =>
      (await tx<{ id: string }>`
        INSERT INTO menu_item_options (restaurant_id, menu_item_id, name, price_delta_cents, active)
        VALUES (${restaurantId}, ${itemId}, ${name}, ${delta}, ${active}) RETURNING id`)[0]!.id;
    const extraOvo = await opt(moamba, 'Ovo estrelado', 50000);
    const extraInativo = await opt(moamba, 'Extra desativado', 10000, false);
    return {
      categoryId,
      hiddenCategoryId,
      moamba: { id: moamba, price: 450000 },
      sumo: { id: sumo, price: 120000 },
      esgotado: { id: esgotado, price: 600000 },
      inativo: { id: inativo, price: 100000 },
      escondido: { id: escondido, price: 100000 },
      extraOvo: { id: extraOvo, price: 50000 },
      extraInativo: { id: extraInativo },
    };
  });
}

/** Restaurante completo com gerente, cozinha, empregado, 2 mesas e menu. */
export async function seedFullRestaurant(t: TestApp, name = 'Restaurante Teste', prefix = 'a', extra: { feeBps?: number } = {}) {
  const restaurantId = await seedRestaurant(t, name, extra);
  const emails = {
    manager: `${prefix}.gerente@teste.pt`,
    kitchen: `${prefix}.cozinha@teste.pt`,
    waiter: `${prefix}.empregado@teste.pt`,
  };
  const userIds = {
    manager: await seedUser(t, { restaurantId, email: emails.manager, role: 'manager' }),
    kitchen: await seedUser(t, { restaurantId, email: emails.kitchen, role: 'kitchen' }),
    waiter: await seedUser(t, { restaurantId, email: emails.waiter, role: 'waiter' }),
  };
  const table1 = await seedTable(t, restaurantId, 1);
  const table2 = await seedTable(t, restaurantId, 2, 'Esplanada');
  const menu = await seedMenu(t, restaurantId);
  return { restaurantId, emails, userIds, table1, table2, menu };
}

export const uniqueKey = () => randomToken(18);

export function orderBody(menu: SeededMenu, extra: Record<string, unknown> = {}) {
  return { items: [{ menu_item_id: menu.moamba.id, quantity: 2, options: [{ option_id: menu.extraOvo.id }] }, { menu_item_id: menu.sumo.id, quantity: 1 }], ...extra };
}
