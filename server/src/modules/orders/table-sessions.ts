// Sessões de mesa: agrupam os pedidos de uma mesma ocupação da mesa (histórico "da mesa" para o cliente).
import type { Tx } from '../../db/client';

export interface TableRef {
  restaurantId: string;
  tableId: string;
}

/** Sessão aberta e ainda ativa da mesa (ou null). */
export async function currentSessionId(tx: Tx, t: TableRef, ttlMinutes: number): Promise<string | null> {
  const [s] = await tx<{ id: string }>`
    SELECT id FROM table_sessions
    WHERE restaurant_id = ${t.restaurantId} AND table_id = ${t.tableId} AND closed_at IS NULL
      AND last_activity_at > now() - make_interval(mins => ${ttlMinutes})`;
  return s?.id ?? null;
}

/** Abre (ou renova) a sessão da mesa; fecha a anterior se estiver parada há demasiado tempo. */
export async function ensureTableSession(tx: Tx, t: TableRef, ttlMinutes: number): Promise<string> {
  const [open] = await tx<{ id: string; stale: boolean }>`
    SELECT id, last_activity_at < now() - make_interval(mins => ${ttlMinutes}) AS stale
    FROM table_sessions
    WHERE restaurant_id = ${t.restaurantId} AND table_id = ${t.tableId} AND closed_at IS NULL
    FOR UPDATE`;
  if (open && !open.stale) {
    await tx`UPDATE table_sessions SET last_activity_at = now() WHERE id = ${open.id}`;
    return open.id;
  }
  if (open) await tx`UPDATE table_sessions SET closed_at = now(), close_reason = 'expirada' WHERE id = ${open.id}`;
  const [created] = await tx<{ id: string }>`
    INSERT INTO table_sessions (restaurant_id, table_id) VALUES (${t.restaurantId}, ${t.tableId})
    ON CONFLICT (table_id) WHERE closed_at IS NULL DO NOTHING
    RETURNING id`;
  if (created) return created.id;
  // outro pedido simultâneo abriu a sessão entretanto. Bloqueia-se a linha (FOR UPDATE) tal como no caminho normal:
  // a ordem de bloqueios tem de ser sempre a mesma (sessão da mesa → contador de pedidos) para não haver impasses.
  const [again] = await tx<{ id: string }>`
    SELECT id FROM table_sessions
    WHERE restaurant_id = ${t.restaurantId} AND table_id = ${t.tableId} AND closed_at IS NULL
    FOR UPDATE`;
  return again!.id;
}
