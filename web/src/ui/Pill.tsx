import type { ApiError } from '../lib/api';

/** Mostra se o ecrã se atualiza em tempo real, a cada poucos segundos ou se está sem ligação. */
export function ConnectionPill({ live, error }: { live: boolean; error?: ApiError | null }) {
  if (error?.isNetwork) return <span className="pill pill-off">Sem ligação</span>;
  if (live) return <span className="pill pill-live">Em tempo real</span>;
  return <span className="pill pill-poll">A atualizar de poucos em poucos segundos</span>;
}
