// Folhas da página da equipa: adicionar uma pessoa (com palavra-passe temporária) e gerir uma pessoa existente.
import { useLayoutEffect, useState } from 'react';
import type { StaffMember } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { Button } from '../../ui/Button';
import { SelectField, Switch, TextField } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { CredentialCard } from '../CredentialCard';
import { team as teamApi } from '../data';
import { fieldErrors } from '../forms';
import { ConfirmSheet } from '../orders/ConfirmSheet';

export type TeamRole = 'manager' | 'waiter' | 'kitchen';

export const TEAM_ROLES: Array<{ value: TeamRole; label: string; help: string }> = [
  { value: 'waiter', label: 'Empregado de mesa', help: 'Entrega os pedidos prontos e regista pedidos e pagamentos das mesas. Não vê relatórios nem muda o menu.' },
  { value: 'kitchen', label: 'Cozinha', help: 'Vê os pedidos novos, marca-os como em preparação e prontos, e pode esgotar pratos. Não vê pagamentos.' },
  { value: 'manager', label: 'Gerente', help: 'Acesso total: pedidos, menu, mesas, equipa, relatórios e definições.' },
];
export const roleLabel = (role: string) => TEAM_ROLES.find((r) => r.value === role)?.label ?? role;
const roleHelp = (role: string) => TEAM_ROLES.find((r) => r.value === role)?.help ?? '';
const loginUrl = () => `${window.location.origin}/entrar`;

// ---------------------------------------------------------------------------------------------------------------
// Adicionar uma pessoa
// ---------------------------------------------------------------------------------------------------------------
interface AddProps {
  open: boolean;
  /** Nome do restaurante, para a mensagem pronta. */
  place: string;
  onClose: () => void;
  onCreated: () => void;
}

export function AddMemberSheet({ open, place, onClose, onCreated }: AddProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('waiter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ member: StaffMember; temporary_password: string } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    setName('');
    setEmail('');
    setRole('waiter');
    setBusy(false);
    setError(null);
    setErrors({});
    setCreated(null);
  }, [open]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    const problems: Record<string, string> = {};
    const n = name.trim();
    const e = email.trim();
    if (n.length < 2) problems.name = 'Escreva o nome da pessoa.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) problems.email = 'Escreva um e-mail válido, por exemplo nome@exemplo.com.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      const res = await teamApi.create({ name: n, email: e, role });
      setCreated(res);
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
        setErrors({ email: 'Já existe uma conta com este e-mail. Se a pessoa já trabalha noutro sítio, peça ajuda à Altiora Grupo.' });
      } else {
        const fields = fieldErrors(err);
        if (Object.keys(fields).length > 0) setErrors(fields);
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
      title={created ? 'Conta criada' : 'Adicionar pessoa'}
      footer={
        created ? (
          <Button size="big" block onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <Button size="big" block loading={busy} onClick={() => void submit()}>
            Criar conta
          </Button>
        )
      }
    >
      {created ? (
        <CredentialCard kind="nova" name={created.member.name} email={created.member.email} password={created.temporary_password} place={place} loginUrl={loginUrl()} />
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
            label="Nome"
            value={name}
            maxLength={120}
            autoComplete="off"
            error={errors.name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((cur) => ({ ...cur, name: '' }));
            }}
          />
          <TextField
            label="E-mail"
            type="email"
            value={email}
            maxLength={254}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            hint="É com este e-mail que a pessoa entra. Tem de ser só dela."
            error={errors.email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((cur) => ({ ...cur, email: '' }));
            }}
          />
          <SelectField label="Função" value={role} hint={roleHelp(role)} error={errors.role} onChange={(e) => setRole(e.target.value as TeamRole)}>
            {TEAM_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </SelectField>
          <p className="muted small">Vamos criar uma palavra-passe temporária para lhe dar. No primeiro acesso, a pessoa escolhe uma palavra-passe só sua.</p>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Gerir uma pessoa
// ---------------------------------------------------------------------------------------------------------------
interface ManageProps {
  member: StaffMember | null;
  place: string;
  onClose: () => void;
  onChanged: () => void;
}

export function MemberSheet({ member, place, onClose, onChanged }: ManageProps) {
  const toast = useToast();
  const [role, setRole] = useState<TeamRole>('waiter');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promote, setPromote] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [creds, setCreds] = useState<{ email: string; temporary_password: string } | null>(null);

  const id = member?.user_id ?? null;
  useLayoutEffect(() => {
    if (!member) return;
    setRole(member.role as TeamRole);
    setActive(member.active);
    setBusy(false);
    setError(null);
    setPromote(false);
    setResetting(false);
    setCreds(null);
    // só ao abrir (ou ao mudar de pessoa); as atualizações da lista não devem apagar o que a pessoa está a editar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!member) return null;
  const dirty = role !== member.role || active !== member.active;

  const persist = async () => {
    const body: { role?: TeamRole; active?: boolean } = {};
    if (role !== member.role) body.role = role;
    if (active !== member.active) body.active = active;
    await teamApi.update(member.user_id, body);
    toast.show('Alterações guardadas.');
    onChanged();
    onClose();
  };

  const save = async () => {
    if (busy || !dirty) return;
    if (role === 'manager' && member.role !== 'manager') {
      setPromote(true);
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
    const res = await teamApi.resetPassword(member.user_id);
    setCreds(res);
    setResetting(false);
    onChanged();
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        locked={busy || !!creds}
        title={creds ? 'Palavra-passe reposta' : member.name}
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
          <CredentialCard kind="reposta" name={member.name} email={creds.email} password={creds.temporary_password} place={place} loginUrl={loginUrl()} />
        ) : (
          <div className="stack-lg">
            {error ? (
              <div className="notice notice-danger" role="alert">
                {error}
              </div>
            ) : null}
            <p className="muted">{member.email}</p>
            <div className="stack">
              <SelectField label="Função" value={role} hint={roleHelp(role)} onChange={(e) => setRole(e.target.value as TeamRole)}>
                {TEAM_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </SelectField>
              <Switch checked={active} onChange={setActive} label="Tem acesso ao painel" />
              {!active && member.active ? <p className="notice notice-danger">Ao guardar, {member.name} perde o acesso de imediato e as sessões abertas terminam. Os pedidos que registou ficam no histórico.</p> : null}
              {active && !member.active ? <p className="muted small">Ao guardar, {member.name} volta a poder entrar com a mesma palavra-passe.</p> : null}
            </div>

            <div className="sheet-section stack-sm">
              <h3 className="section-title">Palavra-passe</h3>
              {member.role === 'manager' ? (
                <p className="muted small">A palavra-passe de um gerente é reposta pela Altiora Grupo, por segurança. Fale connosco se for preciso.</p>
              ) : !member.active ? (
                <p className="muted small">Ative a pessoa e guarde, para poder repor a palavra-passe.</p>
              ) : (
                <>
                  <p className="muted small">Se {member.name} se esqueceu da palavra-passe, crie uma temporária. A atual deixa de funcionar.</p>
                  <Button variant="secondary" disabled={busy || dirty} onClick={() => setResetting(true)}>
                    Repor palavra-passe
                  </Button>
                  {dirty ? <p className="muted small">Guarde primeiro as alterações acima.</p> : null}
                </>
              )}
            </div>
          </div>
        )}
      </Sheet>
      <ConfirmSheet
        open={promote}
        title="Dar acesso total?"
        confirmLabel={`Tornar ${member.name} gerente`}
        onClose={() => setPromote(false)}
        onConfirm={async () => {
          await persist();
          setPromote(false);
        }}
      >
        <p>
          Um gerente vê os relatórios e as vendas, muda o menu, as mesas e a equipa, e pode até desativar outros gerentes. Faça isto só com pessoas de confiança.
        </p>
      </ConfirmSheet>
      <ConfirmSheet open={resetting} title="Repor palavra-passe" confirmLabel="Repor e mostrar a nova" onClose={() => setResetting(false)} onConfirm={reset}>
        <p>
          A palavra-passe atual de <strong>{member.name}</strong> deixa de funcionar e as sessões abertas terminam. Vai ver uma palavra-passe temporária, que só aparece uma vez, para lhe dar.
        </p>
      </ConfirmSheet>
    </>
  );
}
