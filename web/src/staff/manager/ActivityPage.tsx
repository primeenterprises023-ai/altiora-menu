// Atividade da equipa (plano com «Gestão avançada»): quem fez o quê no restaurante, do mais recente para o mais antigo.
// As frases vêm prontas do servidor (sem endereços IP nem dados técnicos). A primeira página atualiza sozinha; «Ver mais antigos» continua para trás.
import { useEffect, useMemo, useState } from 'react';
import { actorRoleLabel } from '../../../../shared/activity';
import type { ActivityEntry } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { fmtDate, fmtTime } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { activity as activityApi } from '../data';
import { useDocumentTitle } from '../hooks';
import { useRestaurant } from '../Shell';

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
/** Ordem do mais recente para o mais antigo (os ids são números grandes escritos como texto). */
const newestFirst = (a: ActivityEntry, b: ActivityEntry) => (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0);

interface Loaded {
  byId: Map<string, ActivityEntry>;
  /** Onde continua o «Ver mais antigos»; null = já não há mais. */
  cursor: string | null;
}

export default function ActivityPage() {
  useDocumentTitle('Atividade da equipa');
  const { restaurant } = useRestaurant();
  const timezone = restaurant?.timezone;
  const live = useLive((signal) => activityApi.list(undefined, signal), { pollMs: 30_000, safetyMs: 120_000 });

  // junta tudo o que já foi lido (primeira página que atualiza + páginas antigas), sem repetir nem deixar buracos
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  useEffect(() => {
    const d = live.data;
    if (!d) return;
    setLoaded((prev) => {
      const byId = new Map(prev?.byId);
      for (const e of d.entries) byId.set(e.id, e);
      return { byId, cursor: prev ? prev.cursor : d.next_before };
    });
  }, [live.data]);

  const loadMore = async () => {
    if (!loaded?.cursor || more.busy) return;
    setMore({ busy: true, error: null });
    try {
      const page = await activityApi.list(loaded.cursor);
      setLoaded((prev) => {
        const byId = new Map(prev?.byId);
        for (const e of page.entries) byId.set(e.id, e);
        return { byId, cursor: page.next_before };
      });
      setMore({ busy: false, error: null });
    } catch (err) {
      setMore({ busy: false, error: errorText(err) });
    }
  };

  const days = useMemo(() => {
    const entries = loaded ? [...loaded.byId.values()].sort(newestFirst) : [];
    const today = fmtDate(new Date().toISOString(), timezone);
    const yesterday = fmtDate(new Date(Date.now() - 86_400_000).toISOString(), timezone);
    const groups: Array<{ key: string; label: string; items: ActivityEntry[] }> = [];
    for (const e of entries) {
      const key = fmtDate(e.at, timezone);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        g = { key, label: key === today ? 'Hoje' : key === yesterday ? 'Ontem' : key, items: [] };
        groups.push(g);
      }
      g.items.push(e);
    }
    return groups;
  }, [loaded, timezone]);

  if (live.loading && !loaded) return <Loading rows={5} />;
  if (!loaded) return <ErrorState error={live.error} onRetry={live.refresh} />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Atividade da equipa</h1>
          <p className="muted small">O que a equipa fez no restaurante: menu, mesas, QR Codes, pedidos e acessos. Do mais recente para o mais antigo.</p>
        </div>
      </div>

      <StaleNotice error={live.error} />

      {days.length === 0 ? (
        <EmptyState title="Ainda sem atividade registada.">Quando a equipa alterar o menu, as mesas ou os pedidos, aparece aqui.</EmptyState>
      ) : (
        <div className="stack-lg">
          {days.map((g) => (
            <section key={g.key} className="stack-sm" aria-label={g.label}>
              <h2 className="section-title">{g.label}</h2>
              <ol className="activity">
                {g.items.map((e) => (
                  <li key={e.id} className="activity-row">
                    <time className="activity-time" dateTime={e.at}>
                      {fmtTime(e.at, timezone)}
                    </time>
                    <div className="activity-body">
                      <p className="activity-text">
                        <strong>{e.actor_name ?? 'Conta removida'}</strong> {lowerFirst(e.text)}
                      </p>
                      {actorRoleLabel(e.actor_role) ? <p className="activity-meta">{actorRoleLabel(e.actor_role)}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}

          {loaded.cursor ? (
            <div className="stack-sm">
              <Button variant="secondary" loading={more.busy} onClick={() => void loadMore()}>
                Ver mais antigos
              </Button>
              {more.error ? (
                <p className="field-error" role="alert">
                  {more.error}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="muted small">Chegou ao início do registo.</p>
          )}
        </div>
      )}
    </div>
  );
}
