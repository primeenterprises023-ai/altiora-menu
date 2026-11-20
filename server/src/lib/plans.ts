// Funcionalidades incluídas no plano de cada restaurante. A lista vem da base de dados (a Altiora edita os planos no painel)
// e guarda-se 15 segundos em memória: um pedido de um cliente não deve custar uma consulta extra à base de dados.
import { DEFAULT_PLANS, isFeatureKey, type FeatureKey } from '../../../shared/plans';
import type { Database } from '../db/client';
import { HttpError } from './errors';

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; features: ReadonlySet<FeatureKey> }>();
/** Sem assinatura registada, o restaurante fica só com o essencial (plano mais simples). */
const BASELINE: ReadonlySet<FeatureKey> = new Set(DEFAULT_PLANS[0]!.features);

export async function restaurantFeatures(db: Database, restaurantId: string): Promise<ReadonlySet<FeatureKey>> {
  const hit = cache.get(restaurantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.features;
  const rows = await db.system((tx) =>
    tx<{ features: string[] }>`SELECT p.features FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.restaurant_id = ${restaurantId}`,
  );
  const features: ReadonlySet<FeatureKey> = rows[0] ? new Set(rows[0].features.filter(isFeatureKey)) : BASELINE;
  if (cache.size > 5000) cache.clear();
  cache.set(restaurantId, { at: Date.now(), features });
  return features;
}

/** A Altiora mudou um plano ou uma assinatura: esquece o que estava guardado (uma instância; as outras renovam em 15 s). */
export function clearFeatureCache(): void {
  cache.clear();
}

/** Recusa (403) a operação se o plano do restaurante não inclui a funcionalidade. */
export async function requireFeature(db: Database, restaurantId: string, feature: FeatureKey, what: string): Promise<void> {
  const features = await restaurantFeatures(db, restaurantId);
  if (!features.has(feature)) {
    throw new HttpError(403, 'PLAN_FEATURE', `O plano do seu restaurante não inclui ${what}. Fale com a Altiora Grupo para o ativar.`, { feature });
  }
}
