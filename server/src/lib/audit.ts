import type { Tx } from '../db/client';

export interface AuditEntry {
  restaurantId: string | null;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Dados não sensíveis (nunca palavras-passe, tokens ou códigos). */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Acrescenta uma linha ao registo de auditoria (só se acrescenta; ninguém altera nem apaga). */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.unsafe(
    `INSERT INTO audit_logs (restaurant_id, actor_id, actor_role, action, entity_type, entity_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [e.restaurantId, e.actorId, e.actorRole, e.action, e.entityType ?? null, e.entityId ?? null, e.metadata ?? {}, e.ip ?? null],
  );
}
