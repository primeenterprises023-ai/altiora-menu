// Ponto de arranque do servidor: configuração → base de dados → migrações → verificação de segurança → HTTP.
import { createApp } from './app';
import { purgeExpiredSessions } from './auth/sessions';
import { bootstrapPlatformAdmin } from './bootstrap';
import { ConfigError, databaseTransportWarning, loadConfig } from './config';
import { Database } from './db/client';
import { runMigrations } from './db/migrate';
import { seedShowcase } from './demo/showcase';
import { buildDeps } from './deps';
import { createLogger } from './lib/log';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('\nNão foi possível arrancar: a configuração tem problemas.\n' + err.problems.map((p) => ' - ' + p).join('\n') + '\n');
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(config.logLevel);
  if (config.bootstrapIncomplete) {
    log.warn('BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD só funcionam em conjunto: a conta de administração inicial não foi criada. (Se já entrou pela primeira vez, pode apagar as duas variáveis.)');
  }
  const db = new Database(config.databaseUrl, { max: config.databasePoolMax, ssl: config.databaseSsl, prepare: config.databasePrepare });

  // 1) base de dados acessível?
  let reachable = false;
  for (let attempt = 1; attempt <= 5 && !reachable; attempt++) {
    reachable = await db.ping();
    if (!reachable) {
      log.warn('base de dados ainda não responde', { attempt, motivo: db.lastPingError });
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (!reachable) {
    log.error('Não foi possível ligar à base de dados. Verifique DATABASE_URL (e DATABASE_SSL).', { motivo: db.lastPingError });
    process.exit(1);
  }
  if (config.isProd) {
    const warning = databaseTransportWarning(config.databaseUrl, config.databaseSsl);
    if (warning) log.warn(warning);
    if (!process.env.PUBLIC_BASE_URL?.trim() && process.env.RENDER_EXTERNAL_URL) {
      log.info('PUBLIC_BASE_URL não está definido: a usar o endereço do Render. Se ligar um domínio próprio, defina PUBLIC_BASE_URL antes de imprimir os QR Codes.', { endereco: config.publicBaseUrl });
    }
  }

  // 2) migrações (criam/atualizam tabelas e regras de segurança)
  if (config.autoMigrate) {
    try {
      const result = await runMigrations(db.sql, config.migrationsDir, log);
      log.info('migrações verificadas', { novas: result.applied.length, ja_aplicadas: result.alreadyApplied.length });
    } catch (err) {
      log.error('Falha nas migrações da base de dados', { err });
      process.exit(1);
    }
  }

  // 3) verificação de segurança: sem RLS e perfis em vigor, o servidor não arranca em produção
  const check = await db.selfTest();
  if (!check.ok) {
    for (const p of check.problems) log.error('verificação de segurança: ' + p);
    if (config.isProd) {
      log.error('O servidor não arranca em produção com estas falhas de segurança.');
      process.exit(1);
    }
  } else {
    log.info('verificação de segurança da base de dados concluída');
  }

  // 4) primeira conta de administração (opcional)
  try {
    await bootstrapPlatformAdmin(db, config, log);
  } catch (err) {
    log.error('Não foi possível criar a conta de administração inicial', { err });
  }

  // 5) restaurante-montra «Casa Aurora» (opcional, só se ainda não existir): serve de demonstração na página comercial
  if (config.seedShowcase) {
    try {
      const result = await seedShowcase(db, config);
      if (result.created) log.info('restaurante de demonstração criado (Casa Aurora)', { endereco: `/r/${result.slug}`, pratos: result.dishes, com_3d: result.models });
      else log.info('restaurante de demonstração já existe: nada a fazer', { endereco: `/r/${result.slug}` });
    } catch (err) {
      // não impede o arranque: pode ter sido criado ao mesmo tempo por outra instância
      log.warn('não foi possível criar o restaurante de demonstração', { err });
    }
  }

  // 6) servidor HTTP
  const deps = buildDeps(config, db, log);
  const app = createApp(deps);
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    idleTimeout: 60,
    maxRequestBodySize: 1024 * 1024,
    fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
    error: (err) => {
      log.error('erro não tratado no servidor HTTP', { err });
      return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Ocorreu um erro inesperado. Tente novamente.' } }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });
  log.info('servidor a ouvir', { port: server.port, host: server.hostname, versao: config.version, ambiente: config.env });

  // tarefas periódicas
  const timers = [
    setInterval(() => void purgeExpiredSessions(db).catch((err) => log.warn('limpeza de sessões falhou', { err })), 60 * 60_000),
    setInterval(() => deps.limiter.prune(), 5 * 60_000),
  ];
  for (const t of timers) (t as { unref?: () => void }).unref?.();

  // encerramento ordenado (o serviço de alojamento envia SIGTERM em cada atualização)
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('a encerrar', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    (force as { unref?: () => void }).unref?.();
    try {
      await server.stop();
      await db.close();
    } catch (err) {
      log.warn('erro ao encerrar', { err });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('promessa rejeitada sem tratamento', { err }));
}

void main();
