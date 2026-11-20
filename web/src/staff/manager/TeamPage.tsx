// Equipa do gerente: quem pode entrar no painel do restaurante, com que função, e como lhe dar acesso.
import { useState } from 'react';
import type { StaffMember } from '../../../../shared/types';
import { fmtDateTime } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { team as teamApi } from '../data';
import { useDocumentTitle } from '../hooks';
import { useRestaurant } from '../Shell';
import { AddMemberSheet, MemberSheet, TEAM_ROLES, roleLabel } from './TeamSheets';

function Person({ m, timezone, onManage }: { m: StaffMember; timezone?: string; onManage: () => void }) {
  return (
    <li className={`person${m.active ? '' : ' is-off'}`}>
      <div className="person-main">
        <p className="person-name">
          {m.name}
          {m.is_self ? <span className="muted"> (você)</span> : null}
        </p>
        <p className="person-email muted small">{m.email}</p>
        <div className="person-tags">
          <Badge>{roleLabel(m.role)}</Badge>
          {!m.active ? <Badge tone="danger">Desativado</Badge> : null}
          {m.active && !m.last_login_at ? <Badge tone="warn">Ainda não entrou</Badge> : null}
          {m.active && m.last_login_at && m.must_change_password ? <Badge tone="warn">Falta trocar a palavra-passe</Badge> : null}
        </div>
        {m.last_login_at ? <p className="muted small">Último acesso: {fmtDateTime(m.last_login_at, timezone)}</p> : null}
      </div>
      {m.is_self ? null : (
        <Button size="sm" variant="secondary" aria-label={`Gerir ${m.name}`} onClick={onManage}>
          Gerir
        </Button>
      )}
    </li>
  );
}

export default function TeamPage() {
  const { restaurant } = useRestaurant();
  const live = useLive<{ members: StaffMember[] }>((signal) => teamApi.list(signal), { pollMs: 60_000, safetyMs: 300_000 });
  const [adding, setAdding] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  useDocumentTitle('Equipa');

  const members = live.data?.members ?? [];
  const activeMembers = members.filter((m) => m.active);
  const inactiveMembers = members.filter((m) => !m.active);
  const managing = managingId ? (members.find((m) => m.user_id === managingId) ?? null) : null;
  const place = restaurant?.name ?? 'o restaurante';
  const alone = members.length > 0 && members.every((m) => m.is_self);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Equipa</h1>
        </div>
        <div className="toolbar">
          <Button onClick={() => setAdding(true)}>Adicionar pessoa</Button>
        </div>
      </div>

      <p className="muted">Quem pode entrar no painel do restaurante. Cada pessoa tem o seu e-mail e a sua palavra-passe: ninguém deve partilhar contas.</p>

      <details className="roles-help">
        <summary>O que cada função pode fazer</summary>
        <dl className="roles-help-body">
          {TEAM_ROLES.slice()
            .sort((a, b) => (a.value === 'manager' ? -1 : b.value === 'manager' ? 1 : 0))
            .map((r) => (
              <div key={r.value}>
                <dt>{r.label}</dt>
                <dd>{r.help}</dd>
              </div>
            ))}
        </dl>
      </details>

      <StaleNotice error={live.data ? live.error : null} />

      {live.loading ? (
        <Loading rows={3} />
      ) : live.error && !live.data ? (
        <ErrorState error={live.error} onRetry={live.refresh} />
      ) : members.length === 0 ? (
        <EmptyState title="Ainda não há ninguém na equipa.">
          <Button className="mt" onClick={() => setAdding(true)}>
            Adicionar a primeira pessoa
          </Button>
        </EmptyState>
      ) : (
        <>
          {alone ? (
            <p className="notice notice-info">
              Por agora só você tem acesso. Adicione os empregados e a cozinha para eles verem os pedidos nos seus próprios telemóveis.
            </p>
          ) : null}
          <ul className="person-list">
            {activeMembers.map((m) => (
              <Person key={m.user_id} m={m} timezone={restaurant?.timezone} onManage={() => setManagingId(m.user_id)} />
            ))}
          </ul>
          {inactiveMembers.length > 0 ? (
            <section className="stack" aria-label="Pessoas desativadas">
              <h2 className="section-title">Desativadas ({inactiveMembers.length})</h2>
              <ul className="person-list">
                {inactiveMembers.map((m) => (
                  <Person key={m.user_id} m={m} timezone={restaurant?.timezone} onManage={() => setManagingId(m.user_id)} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <AddMemberSheet open={adding} place={place} onClose={() => setAdding(false)} onCreated={live.refresh} />
      <MemberSheet member={managing} place={place} onClose={() => setManagingId(null)} onChanged={live.refresh} />
    </div>
  );
}
