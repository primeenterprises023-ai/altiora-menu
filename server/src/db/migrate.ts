// Executor de migrações SQL: aplica, por ordem, os ficheiros de db/migrations/*.sql que ainda não foram aplicados.
// - Cada migração corre numa transação (ou tudo ou nada).
// - Um bloqueio (advisory lock) impede duas instâncias de migrarem ao mesmo tempo.
// - O checksum de cada migração aplicada é verificado: nunca se edita uma migração já aplicada.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQL } from 'bun';
import { sha256Hex } from '../lib/crypto';
import type { Logger } from '../lib/log';

const LOCK_KEY = 'altiora_pedidos_migrations';

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(sql: SQL, dir: string, log?: Logger): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (files.length === 0) throw new Error(`Nenhuma migração encontrada em ${dir}`);

  await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_KEY}'))`);
    await tx.unsafe('CREATE SCHEMA IF NOT EXISTS altiora');
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS altiora.schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // sem RLS desligado em nenhuma tabela do esquema (os perfis da aplicação também não têm acesso a esta)
    await tx.unsafe('ALTER TABLE altiora.schema_migrations ENABLE ROW LEVEL SECURITY');
  });

  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const checksum = sha256Hex(text);
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_KEY}'))`);
      const rows = await tx.unsafe<{ checksum: string }>('SELECT checksum FROM altiora.schema_migrations WHERE name = $1', [file]);
      if (rows.length > 0) {
        if (rows[0]!.checksum !== checksum) {
          throw new Error(`A migração ${file} foi alterada depois de aplicada. Crie uma migração nova em vez de editar esta.`);
        }
        result.alreadyApplied.push(file);
        return;
      }
      await tx.unsafe(`SET LOCAL search_path TO altiora, pg_temp; ${text}`);
      await tx.unsafe('INSERT INTO altiora.schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      result.applied.push(file);
      log?.info('migração aplicada', { migration: file });
    });
  }
  return result;
}
