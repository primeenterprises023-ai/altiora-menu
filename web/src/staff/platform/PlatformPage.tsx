// Área da Altiora Grupo: criar restaurantes e gerentes, suspender ou reativar, repor palavras-passe de gerentes.
// Por desenho, esta área nunca mostra pedidos, menus, mesas, pagamentos, relatórios nem a equipa dos restaurantes.
import { useState } from 'react';
import type { AdminPlan, AdminRestaurant, AdminUsageRow } from '../../../../shared/types';
import { dateText, fmtDate, fmtDateTime, plural, sizeText } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { admin, type AdminAuditEntry } from '../data';
import { plain } from '../forms';
import { useDocumentTitle } from '../hooks';
import { NewRestaurantSheet, RestaurantSheet, statusLabel } from './PlatformSheets';

const TZ = 'Africa/Luanda';

const tone = (status: AdminRestaurant['status']) => (status === 'ativo' ? 'ok' : status === 'suspenso' ? 'warn' : 'danger');

const SUB_TONE: Record<NonNullable<AdminRestaurant['subscription_status']>, 'ok' | 'warn' | 'danger'> = { ativa: 'ok', em_atraso: 'warn', cancelada: 'danger' };
const SUB_LABEL: Record<NonNullable<AdminRestaurant['subscription_status']>, string> = { ativa: 'Assinatura ativa', em_atraso: 'Assinatura em atraso', cancelada: 'Assinatura cancelada' };

function RestaurantCard({ r, planName, usage, onManage }: { r: AdminRestaurant; planName: string | null; usage: AdminUsageRow | undefined; onManage: () => void }) {
  return (
    <li className={`person${r.status === 'ativo' ? '' : ' is-off'}`}>
      <div className="person-main">
        <p className="person-name">{r.name}</p>
        <p className="person-email muted small">
          {r.slug} · criado em {fmtDate(r.created_at, TZ)}
        </p>
        <div className="person-tags">
          <Badge tone={tone(r.status)}>{statusLabel(r.status)}</Badge>
          {planName ? <Badge>{`Plano ${planName}`}</Badge> : null}
          {r.subscription_status && r.subscription_status !== 'ativa' ? <Badge tone={SUB_TONE[r.subscription_status]}>{SUB_LABEL[r.subscription_status]}</Badge> : null}
          {r.is_demo ? <Badge>Demonstração</Badge> : null}
          {r.managers.length === 0 ? <Badge tone="warn">Sem gerente ativo</Badge> : null}
        </div>
        {r.valid_until ? <p className="muted small">Assinatura válida até {dateText(r.valid_until)}</p> : null}
        {usage ? (
          <p className="muted small">
            {plural(usage.tables_count, 'mesa', 'mesas')} · {plural(usage.items_count, 'prato', 'pratos')}
            {usage.items_with_3d > 0 ? ` (${usage.items_with_3d} em 3D)` : ''} · {plural(usage.orders_30d, 'pedido', 'pedidos')} em 30 dias · {sizeText(usage.assets_bytes)} de ficheiros
          </p>
        ) : null}
        {r.managers.length > 0 ? (
          <p className="muted small">
            {r.managers.length === 1 ? 'Gerente' : 'Gerentes'}: {r.managers.map((m) => `${m.name} (${m.email})`).join(', ')}
          </p>
        ) : null}
      </div>
      <Button size="sm" variant="secondary" aria-label={`Gerir ${r.name}`} onClick={onManage}>
        Gerir
      </Button>
    </li>
  );
}

/** Números gerais da plataforma: só contagens (a Altiora nunca vê pedidos, valores nem clientes). */
function Overview({ restaurants, usage }: { restaurants: AdminRestaurant[]; usage: AdminUsageRow[] }) {
  const active = restaurants.filter((r) => r.status === 'ativo').length;
  const sum = (pick: (u: AdminUsageRow) => number) => usage.reduce((n, u) => n + pick(u), 0);
  const orders = sum((u) => u.orders_30d);
  const dishes = sum((u) => u.items_count);
  const with3d = sum((u) => u.items_with_3d);
  const late = restaurants.filter((r) => r.subscription_status === 'em_atraso').length;
  return (
    <div className="kpi-grid" aria-label="Números gerais da plataforma">
      <div className="kpi kpi-paid">
        <p className="kpi-label">Restaurantes ativos</p>
        <p className="kpi-value">
          {active} <span className="kpi-of">de {restaurants.length}</span>
        </p>
        <p className="kpi-sub">{late > 0 ? `${plural(late, 'assinatura em atraso', 'assinaturas em atraso')}` : 'Nenhuma assinatura em atraso'}</p>
      </div>
      <div className="kpi kpi-sales">
        <p className="kpi-label">Pedidos em 30 dias</p>
        <p className="kpi-value">{orders}</p>
        <p className="kpi-sub">Soma de todos os restaurantes</p>
      </div>
      <div className="kpi kpi-due">
        <p className="kpi-label">Pratos com 3D</p>
        <p className="kpi-value">
          {with3d} <span className="kpi-of">de {dishes}</span>
        </p>
        <p className="kpi-sub">Pratos nos menus</p>
      </div>
      <div className="kpi kpi-cancel">
        <p className="kpi-label">Ficheiros guardados</p>
        <p className="kpi-value">{sizeText(sum((u) => u.assets_bytes))}</p>
        <p className="kpi-sub">Fotografias e modelos 3D</p>
      </div>
    </div>
  );
}

/** Descreve em português o que cada ação registada quer dizer. */
function describe(e: AdminAuditEntry, nameOf: (id: string | null) => string): string {
  const meta = e.metadata ?? {};
  const place = nameOf(e.restaurant_id);
  switch (e.action) {
    case 'platform.restaurant.create': {
      const mail = typeof meta.manager_email === 'string' ? meta.manager_email : null;
      return `Criou o restaurante ${place}${mail ? ` e o gerente ${mail}${meta.existing_account === true ? ' (conta que já existia)' : ''}` : ''}.`;
    }
    case 'platform.restaurant.update': {
      const parts: string[] = [];
      if (typeof meta.status === 'string') parts.push(`mudou o estado de ${place} para ${statusLabel(meta.status).toLowerCase()}`);
      if (meta.renamed === true) parts.push(`mudou o nome de ${place}`);
      return parts.length > 0 ? `${parts.join(' e ').replace(/^./, (c) => c.toUpperCase())}.` : `Alterou ${place}.`;
    }
    case 'platform.manager.password_reset':
      return `Repôs a palavra-passe de um gerente de ${place}.`;
    case 'platform.subscription.update': {
      const from = typeof meta.from === 'string' ? meta.from : null;
      const to = typeof meta.to === 'string' ? meta.to : null;
      const status = typeof meta.status === 'string' ? ` (${meta.status.replace('_', ' ')})` : '';
      return from && to && from !== to ? `Mudou a assinatura de ${place} do plano ${from} para ${to}${status}.` : `Atualizou a assinatura de ${place}${status}.`;
    }
    case 'platform.plan.create':
      return typeof meta.code === 'string' ? `Criou o plano «${meta.code}».` : 'Criou um plano.';
    case 'platform.plan.update':
      return typeof meta.code === 'string' ? `Alterou o plano «${meta.code}».` : 'Alterou um plano.';
    case 'platform.lead.update':
      return `Mudou o estado de um contacto comercial${typeof meta.status === 'string' ? ` para «${meta.status}»` : ''}.`;
    case 'platform.lead.delete':
      return 'Apagou um contacto comercial.';
    case 'platform.login':
      return 'Iniciou sessão na área da Altiora.';
    case 'platform.password_changed':
      return 'Mudou a própria palavra-passe.';
    case 'platform.admin_bootstrap':
      return 'Foi criada a conta de administração da Altiora.';
    case 'platform.seed_demo':
      return `Criou ${place === 'a plataforma' ? 'o restaurante' : place} com dados de demonstração.`;
    default:
      return `Ação registada (${e.action.slice(0, 60)}).`; // nunca mostra só o código técnico
  }
}

function AuditList({ restaurants }: { restaurants: AdminRestaurant[] }) {
  const live = useLive<{ entries: AdminAuditEntry[] }>((signal) => admin.audit(signal), { pollMs: 60_000, safetyMs: 300_000 });
  const nameOf = (id: string | null) => (id ? (restaurants.find((r) => r.id === id)?.name ?? 'um restaurante removido') : 'a plataforma');
  const entries = live.data?.entries ?? [];

  if (live.loading) return <Loading rows={2} />;
  if (live.error && !live.data) return <ErrorState error={live.error} onRetry={live.refresh} />;
  if (entries.length === 0) return <p className="muted audit-empty">Ainda não há ações registadas.</p>;
  return (
    <ul className="audit-list">
      {entries.map((e) => (
        <li key={e.id}>
          <p>{describe(e, nameOf)}</p>
          <p className="muted small">{fmtDateTime(e.created_at, TZ)}</p>
        </li>
      ))}
    </ul>
  );
}

export default function PlatformPage() {
  const live = useLive<{ restaurants: AdminRestaurant[] }>((signal) => admin.list(signal), { pollMs: 60_000, safetyMs: 300_000 });
  const usageLive = useLive((signal) => admin.usage(signal), { pollMs: 120_000, safetyMs: 300_000 });
  const plansLive = useLive<{ plans: AdminPlan[] }>((signal) => admin.plans(signal), { pollMs: 120_000, safetyMs: 300_000 });
  const plans = plansLive.data?.plans ?? [];
  const usage = usageLive.data?.usage ?? [];
  const planName = (code: string | null) => (code ? (plans.find((p) => p.code === code)?.name ?? code) : null);
  const [creating, setCreating] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [auditOpen, setAuditOpen] = useState(false);
  useDocumentTitle('Restaurantes');

  const all = live.data?.restaurants ?? [];
  const needle = plain(search.trim());
  const shown = needle
    ? all.filter((r) => plain(`${r.name} ${r.slug} ${r.managers.map((m) => `${m.name} ${m.email}`).join(' ')}`).includes(needle))
    : all;
  const managing = managingId ? (all.find((r) => r.id === managingId) ?? null) : null;
  const active = all.filter((r) => r.status === 'ativo').length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Restaurantes</h1>
        </div>
        <div className="toolbar">
          <Button onClick={() => setCreating(true)}>Novo restaurante</Button>
        </div>
      </div>

      <p className="notice notice-info">
        Daqui criam-se restaurantes e gerentes, escolhe-se o plano de cada um, suspendem-se ou reativam-se restaurantes e repõem-se palavras-passe de gerentes. A Altiora Grupo não vê pedidos,
        menus, mesas, pagamentos, relatórios nem a equipa dos restaurantes: só o estado, o plano e números gerais de utilização.
      </p>

      <StaleNotice error={live.data ? live.error : null} />

      {live.loading ? (
        <Loading rows={3} />
      ) : live.error && !live.data ? (
        <ErrorState error={live.error} onRetry={live.refresh} />
      ) : all.length === 0 ? (
        <EmptyState title="Ainda não há restaurantes.">
          <Button className="mt" onClick={() => setCreating(true)}>
            Criar o primeiro restaurante
          </Button>
        </EmptyState>
      ) : (
        <>
          {usageLive.data ? <Overview restaurants={all} usage={usage} /> : null}
          <p className="muted" aria-live="polite">
            {all.length === 1 ? '1 restaurante' : `${all.length} restaurantes`}
            {active === all.length ? ', todos ativos.' : `, ${active} ${active === 1 ? 'ativo' : 'ativos'}.`}
          </p>
          {all.length >= 6 ? (
            <div className="field">
              <label className="label" htmlFor="plat-search">
                Procurar
              </label>
              <input
                id="plat-search"
                className="input"
                type="search"
                value={search}
                placeholder="Nome, endereço ou e-mail do gerente"
                autoComplete="off"
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          ) : null}
          {shown.length === 0 ? (
            <p className="muted">Nenhum restaurante corresponde a “{search.trim()}”.</p>
          ) : (
            <ul className="person-list">
              {shown.map((r) => (
                <RestaurantCard key={r.id} r={r} planName={planName(r.plan_code)} usage={usage.find((u) => u.restaurant_id === r.id)} onManage={() => setManagingId(r.id)} />
              ))}
            </ul>
          )}
        </>
      )}

      <details className="roles-help" onToggle={(e) => setAuditOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Registo das ações da Altiora</summary>
        <div className="audit-body">{auditOpen ? <AuditList restaurants={all} /> : null}</div>
      </details>

      <NewRestaurantSheet
        open={creating}
        plans={plans}
        onClose={() => setCreating(false)}
        onCreated={() => {
          live.refresh();
          usageLive.refresh();
        }}
      />
      <RestaurantSheet
        restaurant={managing}
        plans={plans}
        onClose={() => setManagingId(null)}
        onChanged={() => {
          live.refresh();
          usageLive.refresh();
        }}
      />
    </div>
  );
}
