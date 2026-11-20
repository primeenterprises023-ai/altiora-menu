// Ficheiros de publicação (.env.example, render.yaml, Dockerfile, .dockerignore): não podem ficar desatualizados em relação ao servidor.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_KEYS, loadConfig } from '../src/config';

const root = join(import.meta.dir, '../..');
const read = (name: string) => readFileSync(join(root, name), 'utf8');

/** Lê um ficheiro .env: «CHAVE=valor» (ignora comentários e linhas vazias). */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe('.env.example', () => {
  const env = parseEnv(read('.env.example'));

  test('explica todas as variáveis que o servidor lê e não inventa nenhuma', () => {
    const documented = Object.keys(env).sort();
    expect(documented.filter((k) => !ENV_KEYS.includes(k))).toEqual([]); // nomes que o servidor não conhece
    expect(ENV_KEYS.filter((k) => !documented.includes(k)).sort()).toEqual([]); // variáveis por documentar
  });

  test('os valores de exemplo formam uma configuração válida', () => {
    const c = loadConfig(env);
    expect(c.isProd).toBe(true);
    expect(c.databaseSsl).toBe('require');
    expect(c.databasePrepare).toBe(true);
    expect(c.autoMigrate).toBe(true);
    expect(c.seedShowcase).toBe(false);
    // palavra-passe em branco no exemplo: a conta inicial só é criada quando a pessoa a preenche
    expect(c.bootstrapAdmin).toBeNull();
  });

  test('os valores por omissão escritos no exemplo são os que o servidor realmente usa', () => {
    const base = { DATABASE_URL: env.DATABASE_URL!, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://menu.exemplo.ao' };
    const real = loadConfig(base);
    const shown = loadConfig({ ...base, ...Object.fromEntries(['DATABASE_POOL_MAX', 'ASSET_QUOTA_MB', 'SESSION_IDLE_HOURS', 'SESSION_MAX_DAYS', 'TABLE_SESSION_MINUTES', 'MAX_PENDING_ORDERS_PER_TABLE', 'MIN_SECONDS_BETWEEN_ORDERS', 'SCRYPT_LOG_N', 'LOG_LEVEL', 'PORT', 'HOST', 'TRUST_PROXY_HOPS', 'DEMO_RESTAURANT_SLUG', 'WEB_DIR', 'MIGRATIONS_DIR', 'DEMO_MEDIA_DIR'].map((k) => [k, env[k]!])) });
    expect(shown).toEqual(real);
  });

  test('não traz palavras-passe nem chaves verdadeiras', () => {
    expect(env.BOOTSTRAP_ADMIN_PASSWORD).toBe('');
    expect(env.DATABASE_URL).toContain('A-SUA-PALAVRA-PASSE');
  });
});

describe('render.yaml', () => {
  const yaml = read('render.yaml');
  const keys = [...yaml.matchAll(/^\s*- key: ([A-Z0-9_]+)$/gm)].map((m) => m[1]!);

  test('só usa variáveis que o servidor conhece', () => {
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((k) => !ENV_KEYS.includes(k))).toEqual([]);
  });

  test('os segredos são pedidos no painel (sync: false) e nunca escritos no ficheiro', () => {
    for (const secret of ['DATABASE_URL', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD']) {
      expect(new RegExp(`- key: ${secret}\\n\\s+sync: false`).test(yaml)).toBe(true);
    }
    expect(yaml).not.toMatch(/postgres(ql)?:\/\//);
  });

  test('serviço Docker com verificação de saúde em /api/health, ligação cifrada à base de dados e modo produção', () => {
    expect(yaml).toContain('runtime: docker');
    expect(yaml).toContain('healthCheckPath: /api/health');
    expect(yaml).toMatch(/- key: DATABASE_SSL\n\s+value: require/);
    expect(yaml).toMatch(/- key: NODE_ENV\n\s+value: production/);
  });
});

describe('Dockerfile e .dockerignore', () => {
  const docker = read('Dockerfile');
  const ignore = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  const copied = [...docker.matchAll(/^COPY (?:--chown=\S+ )?(\S+) \S+$/gm)].map((m) => m[1]!);

  test('copia só o necessário e esses caminhos existem no projeto', () => {
    expect(copied.sort()).toEqual(['db/migrations', 'dist', 'scripts/demo-media/assets']);
    for (const p of copied.filter((c) => c !== 'dist')) expect(existsSync(join(root, p))).toBe(true);
  });

  test('o .dockerignore não deixa de fora nada do que é copiado', () => {
    for (const p of copied) {
      for (const rule of ignore) {
        const pattern = rule.replace(/\/$/, '');
        const hit = p === pattern || p.startsWith(pattern + '/') || (pattern.includes('*') && new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(p));
        expect([p, rule, hit]).toEqual([p, rule, false]);
      }
    }
  });

  test('arranca o servidor já construído, sem privilégios de administrador, e as pastas que usa coincidem com a configuração', () => {
    expect(docker).toMatch(/^CMD \["bun", "dist\/server\.js"\]$/m);
    expect(docker).toMatch(/^USER bun$/m);
    const c = loadConfig({ DATABASE_URL: 'postgres://x@h/db' });
    expect(docker).toContain(`MIGRATIONS_DIR=${c.migrationsDir}`);
    expect(docker).toContain(`WEB_DIR=${c.webDir}`);
    expect(docker).toContain(`DEMO_MEDIA_DIR=${c.demoMediaDir}`);
  });
});
