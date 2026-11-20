// Atualizações parciais (PATCH): só se alteram os campos enviados.
// Os nomes de tabelas e colunas vêm SEMPRE do código (lista fixa); os valores vão sempre como parâmetros.
import type { Tx } from './client';

export interface PartialUpdate {
  /** Colunas que podem ser alteradas (nomes fixos no código). */
  columns: readonly string[];
  /** Condição WHERE usando $1..$n para os valores de `whereParams`. */
  where: string;
  whereParams: unknown[];
  /** Colunas devolvidas (nomes fixos no código). */
  returning: string;
}

/** Devolve a linha atualizada, ou null se nenhuma linha correspondeu (ou se não havia nada para alterar). */
export async function updatePartial<T>(
  tx: Tx,
  table: string,
  spec: PartialUpdate,
  input: Record<string, unknown>,
): Promise<T | null> {
  const params: unknown[] = [...spec.whereParams];
  const sets: string[] = [];
  for (const col of spec.columns) {
    if (!Object.prototype.hasOwnProperty.call(input, col) || input[col] === undefined) continue;
    params.push(input[col]);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) return null;
  const rows = await tx.unsafe<T>(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${spec.where} RETURNING ${spec.returning}`, params);
  return rows[0] ?? null;
}
