// O que o plano do restaurante inclui (vem na sessão). Serve para mostrar o que está bloqueado em vez de deixar o gerente tentar e falhar;
// quem decide é sempre o servidor, que recusa o que o plano não inclui.
import { useMemo } from 'react';
import type { FeatureKey } from '../../../shared/plans';
import { useSession } from './session';

export interface Features {
  has: (feature: FeatureKey) => boolean;
}

export function useFeatures(): Features {
  const { user } = useSession();
  const list = user?.features;
  return useMemo(() => {
    const set = new Set<FeatureKey>(list ?? []);
    return { has: (f: FeatureKey) => set.has(f) };
  }, [list]);
}
