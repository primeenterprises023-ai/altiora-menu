// Ensaios de ponta a ponta:   bun run test:e2e
//
// Cria uma base de dados temporária com os dados de demonstração, liga o servidor a sério (com o ecrã já construído em dist/web),
// abre um navegador (Chromium) que simula telemóveis e percorre os cenários de e2e/specs. No fim apaga tudo.
// Os ecrãs de exemplo que os cenários fotografam ficam em e2e/output/.
//
// Precisa de: PostgreSQL local (variável TEST_ADMIN_DATABASE_URL, com um utilizador que possa criar bases de dados),
// Node.js 20 ou superior e o Playwright com o Chromium instalado. Para a leitura dos QR Codes: Python 3 com opencv-python
// (e, para as folhas impressas, o pdftoppm). Sem isso, essas verificações são saltadas e o resumo diz quais.
import { SQL } from 'bun';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.E2E_OUT ?? join(root, 'e2e', 'output');
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
const PASSWORD = 'Ensaio-E2E-2026-ok';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (spawnSync('node', ['--version']).status !== 0) fail('Os ensaios de ponta a ponta precisam do Node.js (versão 20 ou superior) instalado.');

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

mkdirSync(out, { recursive: true });

// o ecrã (dist/web) tem de existir; se não, constrói-se
if (!existsSync(join(root, 'dist', 'web', 'index.html'))) {
  console.log('A construir o ecrã (dist/web)…');
  const build = spawnSync(process.execPath, ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('A construção do ecrã falhou.');
}

const dbName = `altiora_e2e_${randomBytes(4).toString('hex')}`;
const dbUrl = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
})();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const admin = new SQL({ url: ADMIN_URL, max: 1 });
let server: ChildProcess | null = null;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
    server.kill();
    await exited;
  }
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } catch (e) {
    console.error(`Não consegui apagar a base de dados temporária ${dbName}: ${(e as Error).message}`);
  }
  await admin.close().catch(() => undefined);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130));
  });
}

let code = 1;
try {
  try {
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
  } catch (e) {
    fail(`Não consegui criar a base de dados temporária. Confirme que o PostgreSQL está ligado e que TEST_ADMIN_DATABASE_URL aponta para ele.\nEndereço usado: ${ADMIN_URL.replace(/:[^:@/]*@/, ':***@')}\nErro: ${(e as Error).message}`);
  }

  const env = {
    ...process.env,
    DATABASE_URL: dbUrl,
    DATABASE_SSL: 'disable',
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: base,
    NODE_ENV: 'development',
    SCRYPT_LOG_N: '12',
    LOG_LEVEL: 'error',
    WEB_DIR: join(root, 'dist', 'web'),
    // os limites contra abuso têm testes próprios no servidor; aqui o mesmo computador faz muitos pedidos seguidos
    RATE_LIMIT_ENABLED: 'false',
    MIN_SECONDS_BETWEEN_ORDERS: '0',
    MAX_PENDING_ORDERS_PER_TABLE: '50',
    DEMO_PASSWORD: PASSWORD,
  } as Record<string, string>;

  console.log('A preparar a base de dados temporária com os dados de demonstração…');
  const seed = spawnSync(process.execPath, ['scripts/seed-demo.ts'], { cwd: root, env, encoding: 'utf8' });
  if (seed.status !== 0) fail(`Os dados de demonstração não foram criados:\n${seed.stdout}\n${seed.stderr}`);

  console.log(`A ligar o servidor em ${base}…`);
  const logFile = openSync(join(out, 'servidor.log'), 'w');
  server = spawn(process.execPath, ['server/src/main.ts'], { cwd: root, env, stdio: ['ignore', logFile, logFile] });
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      healthy = res.ok;
    } catch {
      /* ainda a arrancar */
    }
    if (!healthy) await Bun.sleep(200);
  }
  if (!healthy) fail(`O servidor não ficou pronto a tempo. Veja ${join(out, 'servidor.log')}.`);

  const run = spawn('node', [join('e2e', 'main.mjs')], {
    cwd: root,
    env: { ...env, E2E_BASE_URL: base, E2E_PASSWORD: PASSWORD, E2E_OUT: out },
    stdio: 'inherit',
  });
  code = await new Promise<number>((resolve) => run.once('exit', (c) => resolve(c ?? 1)));
} finally {
  await cleanup();
}
process.exit(code);
