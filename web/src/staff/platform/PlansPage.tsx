// Planos comerciais (Altiora): o que cada plano inclui e quanto custa em cada moeda. Os preços aparecem na página comercial.
// Não há pagamentos no sistema: a assinatura de cada restaurante só diz que plano tem, em que estado e até quando.
import { useState } from 'react';
import { FEATURES } from '../../../../shared/plans';
import { formatMoney } from '../../../../shared/money';
import type { AdminPlan } from '../../../../shared/types';
import { useLive } from '../../lib/live';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { admin } from '../data';
import { useDocumentTitle } from '../hooks';
import { PlanSheet } from './PlanSheet';

function PlanCard({ plan, onEdit }: { plan: AdminPlan; onEdit: () => void }) {
  return (
    <li className={`plan-card${plan.active ? '' : ' is-off'}`}>
      <div className="plan-card-head">
        <div>
          <h2 className="plan-card-name voice">{plan.name}</h2>
          <p className="muted small">código: {plan.code}</p>
        </div>
        <div className="plan-card-tags">
          {plan.highlighted ? <Badge tone="ok">Em destaque</Badge> : null}
          {!plan.active ? <Badge tone="warn">Indisponível</Badge> : null}
        </div>
      </div>
      {plan.tagline ? <p>{plan.tagline}</p> : null}

      {plan.prices.length === 0 ? (
        <p className="muted small">Sem preços definidos: na página comercial aparece «Preço sob consulta».</p>
      ) : (
        <ul className="plan-prices">
          {plan.prices.map((p) => (
            <li key={p.currency}>
              <strong>{formatMoney(p.monthly_cents, p.currency)}</strong> por mês
              {p.yearly_cents !== null ? <span className="muted"> · {formatMoney(p.yearly_cents, p.currency)} por ano</span> : null}
            </li>
          ))}
        </ul>
      )}

      <ul className="plan-features" aria-label={`Funcionalidades do plano ${plan.name}`}>
        {plan.features.map((f) => (
          <li key={f}>{FEATURES[f]?.label ?? f}</li>
        ))}
      </ul>

      <div className="plan-card-foot">
        <span className="muted small">{plan.restaurants === 0 ? 'Nenhum restaurante' : plan.restaurants === 1 ? '1 restaurante' : `${plan.restaurants} restaurantes`}</span>
        <Button size="sm" variant="secondary" aria-label={`Editar o plano ${plan.name}`} onClick={onEdit}>
          Editar
        </Button>
      </div>
    </li>
  );
}

export default function PlansPage() {
  useDocumentTitle('Planos');
  const live = useLive<{ plans: AdminPlan[] }>((signal) => admin.plans(signal), { pollMs: 60_000, safetyMs: 300_000 });
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const plans = live.data?.plans ?? [];
  const editingPlan = editing ? (plans.find((p) => p.code === editing) ?? null) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Planos</h1>
        </div>
        <div className="toolbar">
          <Button onClick={() => setCreating(true)}>Novo plano</Button>
        </div>
      </div>

      <p className="notice notice-info">
        Aqui define o que cada plano inclui e os preços em cada moeda; a página comercial mostra estes valores. O sistema não cobra nem regista pagamentos: a assinatura de cada restaurante só
        indica o plano, o estado e a validade. Mudar um plano muda de imediato o que os restaurantes que o usam podem fazer.
      </p>

      <StaleNotice error={live.data ? live.error : null} />

      {live.loading ? (
        <Loading rows={3} />
      ) : live.error && !live.data ? (
        <ErrorState error={live.error} onRetry={live.refresh} />
      ) : plans.length === 0 ? (
        <EmptyState title="Ainda não há planos.">
          <Button className="mt" onClick={() => setCreating(true)}>
            Criar o primeiro plano
          </Button>
        </EmptyState>
      ) : (
        <ul className="plan-grid">
          {plans.map((p) => (
            <PlanCard key={p.code} plan={p} onEdit={() => setEditing(p.code)} />
          ))}
        </ul>
      )}

      <PlanSheet plan={editingPlan} create={creating} onClose={() => (creating ? setCreating(false) : setEditing(null))} onSaved={live.refresh} />
    </div>
  );
}
