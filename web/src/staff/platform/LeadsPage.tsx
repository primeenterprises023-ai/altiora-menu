// Pedidos de contacto vindos do formulário da página comercial: quem quer saber mais sobre o ALTIORA MENU.
import { useState } from 'react';
import type { AdminLead } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { admin } from '../data';
import { useDocumentTitle } from '../hooks';
import { ConfirmSheet } from '../orders/ConfirmSheet';

const TZ = 'Africa/Luanda';
type Filter = AdminLead['status'] | 'todos';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'novo', label: 'Novos' },
  { id: 'contactado', label: 'Contactados' },
  { id: 'arquivado', label: 'Arquivados' },
  { id: 'todos', label: 'Todos' },
];
const STATUS: Record<AdminLead['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'plain' }> = {
  novo: { label: 'Novo', tone: 'warn' },
  contactado: { label: 'Contactado', tone: 'ok' },
  arquivado: { label: 'Arquivado', tone: 'plain' },
};

/** Só dígitos (e o + inicial) para ligações tel: e wa.me. */
export const phoneDigits = (phone: string): string => phone.replace(/[^\d+]/g, '');
const whatsappUrl = (phone: string): string | null => {
  const d = phoneDigits(phone).replace(/^\+/, '');
  return /^\d{9,15}$/.test(d) ? `https://wa.me/${d}` : null;
};

function LeadCard({ lead, busy, onStatus, onDelete }: { lead: AdminLead; busy: boolean; onStatus: (s: AdminLead['status']) => void; onDelete: () => void }) {
  const wa = whatsappUrl(lead.phone);
  const st = STATUS[lead.status];
  return (
    <li className={`lead-card${lead.status === 'novo' ? ' is-new' : ''}`}>
      <div className="lead-head">
        <div>
          <p className="lead-name">{lead.name}</p>
          <p className="muted small">
            {lead.business} · {fmtDateTime(lead.created_at, TZ)}
          </p>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      {lead.message ? <p className="lead-message">{lead.message}</p> : null}
      <div className="lead-contacts">
        <a className="btn btn-secondary btn-sm" href={`tel:${phoneDigits(lead.phone)}`}>
          {lead.phone}
        </a>
        {wa ? (
          <a className="btn btn-secondary btn-sm" href={wa} target="_blank" rel="noopener noreferrer">
            WhatsApp
          </a>
        ) : null}
        <a className="btn btn-secondary btn-sm" href={`mailto:${lead.email}`}>
          {lead.email}
        </a>
      </div>
      <div className="lead-actions">
        {lead.status === 'novo' ? (
          <Button size="sm" loading={busy} onClick={() => onStatus('contactado')}>
            Marcar como contactado
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => onStatus('novo')}>
            Voltar a «Novo»
          </Button>
        )}
        {lead.status !== 'arquivado' ? (
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => onStatus('arquivado')}>
            Arquivar
          </Button>
        ) : null}
        <Button size="sm" variant="danger-quiet" disabled={busy} onClick={onDelete}>
          Apagar
        </Button>
      </div>
    </li>
  );
}

export default function LeadsPage() {
  useDocumentTitle('Contactos');
  const toast = useToast();
  const live = useLive<{ leads: AdminLead[] }>((signal) => admin.leads(signal), { pollMs: 30_000, safetyMs: 120_000 });
  const [filter, setFilter] = useState<Filter>('novo');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AdminLead | null>(null);

  const leads = live.data?.leads ?? [];
  const count = (f: Filter) => (f === 'todos' ? leads.length : leads.filter((l) => l.status === f).length);
  const shown = filter === 'todos' ? leads : leads.filter((l) => l.status === filter);

  const setStatus = async (lead: AdminLead, status: AdminLead['status']) => {
    if (busyId) return;
    setBusyId(lead.id);
    try {
      await admin.setLeadStatus(lead.id, status);
      live.refresh();
    } catch (err) {
      toast.show(errorText(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Contactos</h1>
          <p className="muted small">Pedidos enviados pelo formulário da página comercial.</p>
        </div>
      </div>

      <StaleNotice error={live.data ? live.error : null} />

      {live.loading ? (
        <Loading rows={3} />
      ) : live.error && !live.data ? (
        <ErrorState error={live.error} onRetry={live.refresh} />
      ) : (
        <>
          <div className="chips" role="group" aria-label="Estado dos contactos">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} ({count(f.id)})
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <EmptyState title={filter === 'novo' ? 'Sem contactos novos.' : 'Nada por aqui.'}>
              {leads.length === 0 ? 'Quando alguém preencher o formulário da página comercial, aparece aqui.' : 'Mude o filtro para ver os outros contactos.'}
            </EmptyState>
          ) : (
            <ul className="lead-list">
              {shown.map((l) => (
                <LeadCard key={l.id} lead={l} busy={busyId === l.id} onStatus={(s) => void setStatus(l, s)} onDelete={() => setDeleting(l)} />
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmSheet
        open={!!deleting}
        danger
        title="Apagar este contacto?"
        confirmLabel="Apagar contacto"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await admin.deleteLead(deleting.id);
          setDeleting(null);
          live.refresh();
          toast.show('Contacto apagado.');
        }}
      >
        <p>
          O pedido de <strong>{deleting?.name}</strong> ({deleting?.business}) deixa de existir. Não se pode desfazer. Se só quer tirá-lo da vista, use «Arquivar».
        </p>
      </ConfirmSheet>
    </div>
  );
}
