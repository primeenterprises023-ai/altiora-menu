// O plano do restaurante: o que inclui, o que não inclui, até quando está válido e o espaço de ficheiros usado.
// A Altiora Grupo é quem muda o plano; aqui o gerente só consulta e vê como falar com a Altiora.
import type { FeatureInfo } from '../../../../shared/plans';
import type { PlanOverview } from '../../../../shared/types';
import { dateText, sizeText } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge } from '../../ui/Badge';
import { ErrorState, Loading } from '../../ui/States';
import { plan as planApi } from '../data';
import { useDocumentTitle } from '../hooks';

const STATUS: Record<PlanOverview['status'], { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  ativa: { label: 'Ativa', tone: 'ok' },
  em_atraso: { label: 'Em atraso', tone: 'warn' },
  cancelada: { label: 'Cancelada', tone: 'danger' },
};

export default function PlanPage() {
  useDocumentTitle('O seu plano');
  const live = useLive((signal) => planApi.get(signal), { pollMs: 60_000, safetyMs: 300_000 });
  if (live.loading) return <Loading rows={4} />;
  if (!live.data) return <ErrorState error={live.error} onRetry={live.refresh} />;
  const { plan, catalog, contact } = live.data;
  const included = new Set(plan.features);
  const pct = Math.min(100, Math.round((plan.storage.used_bytes / Math.max(1, plan.storage.quota_bytes)) * 100));
  const st = STATUS[plan.status];
  const whatsapp = contact.whatsapp ? `https://wa.me/${contact.whatsapp}` : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">O seu plano</h1>
        </div>
      </div>

      <div className="settings stack-lg">
        <section className="settings-block stack-sm" aria-labelledby="pl-now">
          <div className="split-head">
            <h2 className="section-title voice" id="pl-now">
              {plan.plan.name}
            </h2>
            <Badge tone={st.tone}>{st.label}</Badge>
          </div>
          {plan.plan.tagline ? <p className="muted">{plan.plan.tagline}</p> : null}
          {plan.valid_until ? <p>Válido até <strong>{dateText(plan.valid_until)}</strong>.</p> : null}
          {plan.status === 'em_atraso' ? (
            <div className="notice notice-danger" role="status">
              A assinatura está em atraso. O menu continua a funcionar; fale com a Altiora Grupo para regularizar.
            </div>
          ) : null}
          {plan.status === 'cancelada' ? (
            <div className="notice notice-danger" role="status">
              A assinatura foi cancelada. Fale com a Altiora Grupo para a reativar.
            </div>
          ) : null}
        </section>

        <section className="settings-block stack-sm" aria-labelledby="pl-feat">
          <h2 className="section-title" id="pl-feat">
            O que o plano inclui
          </h2>
          <ul className="feature-list">
            {catalog.map((f: FeatureInfo) => {
              const on = included.has(f.key);
              return (
                <li key={f.key} className={`feature${on ? ' is-on' : ' is-off'}`}>
                  <span className="feature-mark" aria-hidden="true">
                    {on ? '✓' : '–'}
                  </span>
                  <span className="feature-text">
                    <strong>{f.label}</strong>
                    <span className="muted small">{f.description}</span>
                  </span>
                  <span className="feature-state small">{on ? 'Incluído' : 'Não incluído'}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="settings-block stack-sm" aria-labelledby="pl-store">
          <h2 className="section-title" id="pl-store">
            Espaço de ficheiros
          </h2>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Espaço usado">
            <div className={`meter-fill${pct >= 90 ? ' is-full' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="small">
            {sizeText(plan.storage.used_bytes)} usados de {sizeText(plan.storage.quota_bytes)} ({pct} %)
          </p>
          <p className="muted small">Fotografias, logótipo, capa e modelos 3D dos pratos. Apagar pratos ou trocar fotografias liberta espaço.</p>
        </section>

        <section className="settings-block stack-sm" aria-labelledby="pl-contact">
          <h2 className="section-title" id="pl-contact">
            Mudar de plano ou pedir ajuda
          </h2>
          <p className="muted">O plano é mudado pela Altiora Grupo. Fale connosco:</p>
          {contact.email || contact.phone || whatsapp ? (
            <ul className="contact-list">
              {whatsapp ? (
                <li>
                  <a className="btn btn-secondary" href={whatsapp} target="_blank" rel="noopener">
                    WhatsApp
                  </a>
                </li>
              ) : null}
              {contact.phone ? (
                <li>
                  <a className="btn btn-secondary" href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}>
                    {contact.phone}
                  </a>
                </li>
              ) : null}
              {contact.email ? (
                <li>
                  <a className="btn btn-secondary" href={`mailto:${contact.email}`}>
                    {contact.email}
                  </a>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="muted small">Os contactos da Altiora Grupo ainda não foram configurados neste servidor. Use o contacto que recebeu quando aderiu.</p>
          )}
        </section>
      </div>
    </div>
  );
}
