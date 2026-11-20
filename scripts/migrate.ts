// Aplica as migrações da base de dados:  bun run migrate
// (o servidor também as aplica sozinho ao arrancar, salvo se AUTO_MIGRATE=false)
import { ConfigError, loadConfig } from '../server/src/config';
import { Database } from '../server/src/db/client';
import { runMigrations } from '../server/src/db/migrate';
import { createLogger } from '../server/src/lib/log';

try {
  const config = loadConfig();
  const log = createLogger('info');
  const db = new Database(config.databaseUrl, { max: 2, ssl: config.databaseSsl, prepare: config.databasePrepare });
  const result = await runMigrations(db.sql, config.migrationsDir, log);
  const check = await db.selfTest();
  await db.close();
  console.log(`Migrações novas: ${result.applied.length}; já aplicadas: ${result.alreadyApplied.length}.`);
  if (!check.ok) {
    console.error('Verificação de segurança com problemas:\n - ' + check.problems.join('\n - '));
    process.exit(1);
  }
  console.log('Verificação de segurança: tudo em ordem.');
} catch (err) {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('Falha nas migrações:', (err as Error).message);
  process.exit(1);
}
