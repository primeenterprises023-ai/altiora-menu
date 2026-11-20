// Folhas da página da plataforma: criar um restaurante (com o primeiro gerente) e gerir um restaurante existente.
import { useLayoutEffect, useState } from 'react';
import { CURRENCIES, type Currency } from '../../../../shared/plans';
import { currencySymbol } from '../../../../shared/money';
import type { AdminPlan, AdminRestaurant } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { SelectField, TextArea, TextField } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { CredentialCard } from '../CredentialCard';
import { admin, type AdminStatus, type AdminSubscriptionBody } from '../data';
import { fieldErrors } from '../forms';
import { ConfirmSheet } from '../orders/ConfirmSheet';

const loginUrl = () => `${window.location.origin}/entrar`;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const STATUSES: Array<{ value: AdminStatus; label: string; help: string }> = [
  { value: 'ativo', label: 'Ativo', help: 'Funciona normalmente.' },
  {
    value: 'suspenso',
    label: 'Suspenso',
    help: 'Pausa temporária (por exemplo, mensalidade em atraso): a equipa deixa de conseguir entrar e os clientes deixam de ver o menu. Os dados ficam guardados e pode reativar a qualquer momento.',
  },
  {
    value: 'desativado',
    label: 'Desativado',
    help: 'Para um restaurante que deixou de usar o serviço. Na prática é o mesmo que suspender: ninguém entra e o menu deixa de aparecer. Os dados ficam guardados e pode reativar se voltar.',
  },
];
export const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s;

type SubStatus = NonNullable<AdminRestaurant['subscription_status']>;
export const SUBSCRIPTION_STATUSES: Array<{ value: SubStatus; label: string; help: string }> = [
  { value: 'ativa', label: 'Ativa', help: 'Em dia.' },
  { value: 'em_atraso', label: 'Em atraso', help: 'Só informação: o restaurante continua a funcionar e o gerente vê um aviso na página do plano. Para bloquear o acesso, suspenda o restaurante.' },
  { value: 'cancelada', label: 'Cancelada', help: 'Só informação: o restaurante continua a funcionar até o suspender ou desativar.' },
];

// ---------------------------------------------------------------------------------------------------------------
// Novo restaurante
// ---------------------------------------------------------------------------------------------------------------
interface NewProps {
  open: boolean;
  plans: AdminPlan[];
  onClose: () => void;
  onCreated: () => void;
}

type Created = { restaurant: AdminRestaurant; manager: { email: string; existing_account: boolean; temporary_password: string | null }; managerName: string };

/** O plano que se propõe para um restaurante novo: o "pro" se existir e estiver disponível, senão o primeiro disponível. */
export function defaultPlanCode(plans: AdminPlan[]): string {
  const available = plans.filter((p) => p.active);
  return available.find((p) => p.code === 'pro')?.code ?? available[0]?.code ?? 'pro';
}

export function NewRestaurantSheet({ open, plans, onClose, onCreated }: NewProps) {
  const [planCode, setPlanCode] = useState('pro');
  const [currency, setCurrency] = useState<Currency>('AOA');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [managerName, setManagerName] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Created | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    setPlanCode(defaultPlanCode(plans));
    setCurrency('AOA');
    setName('');
    setSlug('');
    setManagerName('');
    setManagerEmail('');
    setBusy(false);
    setError(null);
    setErrors({});
    setCreated(null);
  }, [open]);

  const clear = (key: string) => setErrors((cur) => ({ ...cur, [key]: '' }));

  const submit = async () => {
    if (busy) return;
    setError(null);
    const n = name.trim();
    const s = slug.trim().toLowerCase();
    const mn = managerName.trim();
    const me = managerEmail.trim().toLowerCase();
    const problems: Record<string, string> = {};
    if (n.length < 2) problems.name = 'Escreva o nome do restaurante (pelo menos 2 letras).';
    if (s && (s.length < 2 || s.length > 60 || !SLUG_RE.test(s))) problems.slug = 'Use apenas letras minúsculas, números e hífenes (ex.: terraza-talatona).';
    if (mn.length < 2) problems.manager_name = 'Escreva o nome do gerente.';
    if (!EMAIL_RE.test(me)) problems.manager_email = 'Escreva um e-mail válido, por exemplo nome@exemplo.com.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const res = await admin.create({ name: n, ...(s ? { slug: s } : {}), plan_code: planCode, currency, manager: { name: mn, email: me } });
      setCreated({ ...res, managerName: mn });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SLUG_TAKEN' && s) {
        setErrors({ slug: 'Este endereço já está em uso por outro restaurante. Escolha outro.' });
      } else if (err instanceof ApiError && err.code === 'EMAIL_IS_PLATFORM_ADMIN') {
        setErrors({ manager_email: 'Este e-mail pertence a uma conta da Altiora Grupo. Use o e-mail do gerente do restaurante.' });
      } else {
        const raw = fieldErrors(err);
        const mapped: Record<string, string> = {};
        if (raw.name) mapped.name = raw.name;
        if (raw.slug) mapped.slug = raw.slug;
        if (raw['manager.name']) mapped.manager_name = raw['manager.name'];
        if (raw['manager.email']) mapped.manager_email = raw['manager.email'];
        if (Object.keys(mapped).length > 0) setErrors(mapped);
        else setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={busy || !!created}
      title={created ? 'Restaurante criado' : 'Novo restaurante'}
      footer={
        created ? (
          <Button size="big" block onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <Button size="big" block loading={busy} onClick={() => void submit()}>
            Criar restaurante
          </Button>
        )
      }
    >
      {created ? (
        <div className="stack-lg">
          <p>
            O restaurante <strong>{created.restaurant.name}</strong> está criado e o gerente já pode entrar.
          </p>
          {created.manager.temporary_password ? (
            <CredentialCard
              kind="nova"
              name={created.managerName}
              email={created.manager.email}
              password={created.manager.temporary_password}
              place={created.restaurant.name}
              loginUrl={loginUrl()}
            />
          ) : (
            <p className="notice notice-info">
              O e-mail <strong>{created.manager.email}</strong> já tinha uma conta. Não foi criada nenhuma palavra-passe nova: a pessoa entra com a que já tem e passa a ter também este restaurante.
            </p>
          )}
        </div>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error ? (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          ) : null}
          <TextField
            label="Nome do restaurante"
            value={name}
            maxLength={120}
            autoComplete="off"
            error={errors.name}
            onChange={(e) => {
              setName(e.target.value);
              clear('name');
            }}
          />
          <TextField
            label="Endereço interno (opcional)"
            value={slug}
            maxLength={60}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            hint="Sem espaços nem acentos, por exemplo terraza-talatona. Se deixar vazio, criamos um a partir do nome."
            error={errors.slug}
            onChange={(e) => {
              setSlug(e.target.value);
              clear('slug');
            }}
          />
          <SelectField label="Plano" value={planCode} hint="Pode mudar depois, na ficha do restaurante." onChange={(e) => setPlanCode(e.target.value)}>
            {plans
              .filter((p) => p.active)
              .map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            {plans.filter((p) => p.active).length === 0 ? <option value="pro">Pro</option> : null}
          </SelectField>
          <SelectField
            label="Moeda dos preços do menu"
            value={currency}
            hint="Escolha com cuidado: depois de haver pedidos, a moeda não se muda."
            onChange={(e) => setCurrency(e.target.value as Currency)}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c} ({currencySymbol(c)})
              </option>
            ))}
          </SelectField>
          <h3 className="section-title">Primeiro gerente</h3>
          <TextField
            label="Nome do gerente"
            value={managerName}
            maxLength={120}
            autoComplete="off"
            error={errors.manager_name}
            onChange={(e) => {
              setManagerName(e.target.value);
              clear('manager_name');
            }}
          />
          <TextField
            label="E-mail do gerente"
            type="email"
            value={managerEmail}
            maxLength={254}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            hint="É com este e-mail que o gerente entra. Tem de ser só dele."
            error={errors.manager_email}
            onChange={(e) => {
              setManagerEmail(e.target.value);
              clear('manager_email');
            }}
          />
          <p className="muted small">Vamos criar uma palavra-passe temporária para lhe dar. No primeiro acesso, o gerente escolhe uma palavra-passe só dele.</p>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Gerir um restaurante
// ---------------------------------------------------------------------------------------------------------------
interface ManageProps {
  restaurant: AdminRestaurant | null;
  plans: AdminPlan[];
  onClose: () => void;
  onChanged: () => void;
}

export function RestaurantSheet({ restaurant, plans, onClose, onChanged }: ManageProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [status, setStatus] = useState<AdminStatus>('ativo');
  const [planCode, setPlanCode] = useState('');
  const [subStatus, setSubStatus] = useState<SubStatus>('ativa');
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [resetFor, setResetFor] = useState<AdminRestaurant['managers'][number] | null>(null);
  const [creds, setCreds] = useState<{ name: string; email: string; temporary_password: string } | null>(null);

  const id = restaurant?.id ?? null;
  useLayoutEffect(() => {
    if (!restaurant) return;
    setName(restaurant.name);
    setStatus(restaurant.status);
    setPlanCode(restaurant.plan_code ?? '');
    setSubStatus(restaurant.subscription_status ?? 'ativa');
    setValidUntil(restaurant.valid_until ?? '');
    setNotes(restaurant.subscription_notes ?? '');
    setBusy(false);
    setError(null);
    setNameError(null);
    setDateError(null);
    setSuspending(false);
    setResetFor(null);
    setCreds(null);
    // só ao abrir (ou ao mudar de restaurante): as atualizações da lista não devem apagar o que está a ser editado
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!restaurant) return null;
  const trimmedName = name.trim();
  const trimmedNotes = notes.trim();
  const dirtyRestaurant = trimmedName !== restaurant.name || status !== restaurant.status;
  const subscription: AdminSubscriptionBody = {};
  if (planCode && planCode !== (restaurant.plan_code ?? '')) subscription.plan_code = planCode;
  if (subStatus !== (restaurant.subscription_status ?? 'ativa')) subscription.status = subStatus;
  if (validUntil !== (restaurant.valid_until ?? '')) subscription.valid_until = validUntil || null;
  if (trimmedNotes !== (restaurant.subscription_notes ?? '')) subscription.notes = trimmedNotes || null;
  const dirtySubscription = Object.keys(subscription).length > 0;
  const dirty = dirtyRestaurant || dirtySubscription;
  const leaving = restaurant.status === 'ativo' && status !== 'ativo';
  // o plano atual pode já não estar "disponível" para novos restaurantes, mas tem de continuar escolhível aqui
  const planOptions = plans.filter((p) => p.active || p.code === restaurant.plan_code);

  const persist = async () => {
    const body: { name?: string; status?: AdminStatus } = {};
    if (trimmedName !== restaurant.name) body.name = trimmedName;
    if (status !== restaurant.status) body.status = status;
    try {
      if (dirtyRestaurant) await admin.update(restaurant.id, body);
      if (dirtySubscription) await admin.updateSubscription(restaurant.id, subscription);
    } finally {
      onChanged(); // mesmo que a segunda gravação falhe, a lista mostra o que já ficou guardado
    }
    toast.show(leaving ? `${restaurant.name} ficou ${statusLabel(status).toLowerCase()}.` : 'Alterações guardadas.');
    onClose();
  };

  const save = async () => {
    if (busy || !dirty) return;
    if (trimmedName.length < 2) {
      setNameError('Escreva o nome do restaurante (pelo menos 2 letras).');
      return;
    }
    setNameError(null);
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      setDateError('Escolha uma data válida.');
      return;
    }
    setDateError(null);
    if (leaving) {
      setSuspending(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await persist();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!resetFor) return;
    const res = await admin.resetManagerPassword(restaurant.id, resetFor.id);
    setCreds({ name: resetFor.name, email: res.manager.email, temporary_password: res.manager.temporary_password });
    setResetFor(null);
    onChanged();
  };

  const baseUrl = restaurant.menu_base_url ?? window.location.origin;
  return (
    <>
      <Sheet
        open
        onClose={onClose}
        locked={busy || !!creds}
        title={creds ? 'Palavra-passe reposta' : restaurant.name}
        footer={
          creds ? (
            <Button size="big" block onClick={onClose}>
              Concluir
            </Button>
          ) : (
            <Button size="big" block loading={busy} disabled={!dirty} onClick={() => void save()}>
              Guardar alterações
            </Button>
          )
        }
      >
        {creds ? (
          <CredentialCard kind="reposta" name={creds.name} email={creds.email} password={creds.temporary_password} place={restaurant.name} loginUrl={loginUrl()} />
        ) : (
          <div className="stack-lg">
            {error ? (
              <div className="notice notice-danger" role="alert">
                {error}
              </div>
            ) : null}
            <div className="stack">
              <TextField
                label="Nome do restaurante"
                value={name}
                maxLength={120}
                autoComplete="off"
                error={nameError ?? undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
              />
              <SelectField label="Estado" value={status} hint={STATUSES.find((s) => s.value === status)?.help} onChange={(e) => setStatus(e.target.value as AdminStatus)}>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </SelectField>
              {leaving ? <p className="notice notice-danger">Ao guardar, a equipa e os clientes deste restaurante perdem o acesso de imediato.</p> : null}
              {!leaving && status === 'ativo' && restaurant.status !== 'ativo' ? <p className="muted small">Ao guardar, o restaurante volta a funcionar de imediato.</p> : null}
            </div>

            <div className="sheet-section stack">
              <h3 className="section-title">Assinatura</h3>
              <SelectField label="Plano" value={planCode} hint={plans.find((p) => p.code === planCode)?.tagline} onChange={(e) => setPlanCode(e.target.value)}>
                {planCode === '' ? <option value="">Sem plano (funciona como o mais simples)</option> : null}
                {planOptions.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                    {p.active ? '' : ' (indisponível para novos)'}
                  </option>
                ))}
              </SelectField>
              <SelectField label="Estado da assinatura" value={subStatus} hint={SUBSCRIPTION_STATUSES.find((x) => x.value === subStatus)?.help} onChange={(e) => setSubStatus(e.target.value as SubStatus)}>
                {SUBSCRIPTION_STATUSES.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Válida até (opcional)"
                type="date"
                value={validUntil}
                hint="Só informação para o gerente: o sistema não bloqueia nem muda o plano sozinho quando a data passa."
                error={dateError ?? undefined}
                onChange={(e) => {
                  setValidUntil(e.target.value);
                  setDateError(null);
                }}
              />
              <TextArea
                label="Nota interna (opcional)"
                value={notes}
                rows={2}
                maxLength={500}
                hint="Só a Altiora vê. Por exemplo: contrato combinado por telefone."
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            <div className="sheet-section stack-sm">
              <h3 className="section-title">Gerentes</h3>
              {restaurant.managers.length === 0 ? (
                <p className="notice">Este restaurante não tem nenhum gerente ativo.</p>
              ) : (
                <ul className="manager-list">
                  {restaurant.managers.map((m) => (
                    <li key={m.id} className="manager-row">
                      <div className="manager-main">
                        <p className="manager-name">{m.name}</p>
                        <p className="muted small manager-email">{m.email}</p>
                      </div>
                      <Button size="sm" variant="secondary" aria-label={`Repor palavra-passe de ${m.name}`} disabled={busy} onClick={() => setResetFor(m)}>
                        Repor palavra-passe
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted small">Se um gerente se esquecer da palavra-passe, crie uma temporária aqui. A atual deixa de funcionar.</p>
            </div>

            <div className="sheet-section stack-sm">
              <h3 className="section-title">Informação</h3>
              <dl className="cred-rows">
                <div>
                  <dt>Identificador</dt>
                  <dd>{restaurant.slug}</dd>
                </div>
                <div>
                  <dt>Criado em</dt>
                  <dd>{fmtDate(restaurant.created_at, 'Africa/Luanda')}</dd>
                </div>
                <div>
                  <dt>Moeda</dt>
                  <dd>
                    {restaurant.currency} ({currencySymbol(restaurant.currency)})
                  </dd>
                </div>
                <div>
                  <dt>Endereço dos QR Codes</dt>
                  <dd>{baseUrl}</dd>
                </div>
              </dl>
              <p className="muted small">A Altiora Grupo não vê pedidos, menus, mesas, pagamentos, relatórios nem a equipa deste restaurante. Só o estado e os gerentes.</p>
            </div>
          </div>
        )}
      </Sheet>
      <ConfirmSheet
        open={suspending}
        danger
        title={status === 'suspenso' ? 'Suspender o restaurante?' : 'Desativar o restaurante?'}
        confirmLabel={status === 'suspenso' ? `Suspender ${restaurant.name}` : `Desativar ${restaurant.name}`}
        onClose={() => setSuspending(false)}
        onConfirm={async () => {
          await persist();
          setSuspending(false);
        }}
      >
        <p>
          A equipa de <strong>{restaurant.name}</strong> deixa de conseguir entrar e os clientes deixam de ver o menu e de fazer pedidos, de imediato. Os pedidos e o menu ficam guardados, e pode reativar o restaurante quando quiser.
        </p>
      </ConfirmSheet>
      <ConfirmSheet open={!!resetFor} title="Repor palavra-passe" confirmLabel="Repor e mostrar a nova" onClose={() => setResetFor(null)} onConfirm={reset}>
        <p>
          A palavra-passe atual de <strong>{resetFor?.name}</strong> deixa de funcionar e as sessões abertas terminam. Vai ver uma palavra-passe temporária, que só aparece uma vez, para lhe dar.
        </p>
      </ConfirmSheet>
    </>
  );
}
