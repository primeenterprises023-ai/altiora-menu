// Criação da primeira conta de administração da plataforma (Altiora Grupo), a partir das variáveis de ambiente.
import { hashPassword, checkPasswordStrength } from './auth/password';
import type { Config } from './config';
import type { Database } from './db/client';
import { audit } from './lib/audit';
import type { Logger } from './lib/log';

export type BootstrapResult = 'created' | 'already-exists' | 'skipped' | 'email-in-use' | 'weak-password';

/**
 * Só cria a conta se ainda NÃO existir nenhum administrador da plataforma.
 * A palavra-passe indicada é temporária: a pessoa é obrigada a trocá-la no primeiro acesso,
 * e deve depois apagar BOOTSTRAP_ADMIN_PASSWORD das variáveis de ambiente.
 */
export async function bootstrapPlatformAdmin(db: Database, config: Config, log: Logger): Promise<BootstrapResult> {
  const b = config.bootstrapAdmin;
  if (!b) return 'skipped';

  const exists = await db.system(async (tx) => (await tx<{ n: number }>`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`)[0]!.n > 0);
  if (exists) return 'already-exists';

  const weak = checkPasswordStrength(b.password, b.email);
  if (weak) {
    log.error('BOOTSTRAP_ADMIN_PASSWORD recusada: ' + weak);
    return 'weak-password';
  }
  const hash = await hashPassword(b.password, config.scryptLogN);
  return db.system(async (tx): Promise<BootstrapResult> => {
    const [taken] = await tx`SELECT 1 FROM users WHERE email = ${b.email}`;
    if (taken) {
      log.error('O e-mail de BOOTSTRAP_ADMIN_EMAIL já pertence a uma conta que não é de administração da plataforma.');
      return 'email-in-use';
    }
    const [u] = await tx<{ id: string }>`
      INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password)
      VALUES (${b.email}, ${b.name}, ${hash}, true, true) RETURNING id`;
    await audit(tx, { restaurantId: null, actorId: u!.id, actorRole: 'platform', action: 'platform.admin_bootstrap', entityType: 'user', entityId: u!.id });
    log.info('conta de administração da plataforma criada (tem de trocar a palavra-passe no primeiro acesso)');
    return 'created';
  });
}
