import { useState, type FormEvent } from 'react';
import type { SessionUser } from '../../../shared/types';
import { ApiError, errorText } from '../lib/api';
import { navigate, useLocation } from '../lib/router';
import { api } from '../lib/api';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Fields';
import { HOME, canOpen, useSession, type AppRole } from './session';

/** Para onde ir depois de entrar: o sítio onde a pessoa estava (se for permitido), ou a página do seu perfil. */
export function destinationAfterLogin(user: SessionUser, from: string | null): string {
  const role = user.role as AppRole;
  if (user.must_change_password) return '/alterar-palavra-passe';
  if (from && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/entrar') && canOpen(role, from) && from !== '/') return from;
  return HOME[role];
}

function Brand() {
  return (
    <div className="auth-brand">
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <rect x="1" y="1" width="32" height="32" rx="9" fill="var(--ink)" />
        <path d="M9 24 L17 9 L25 24 M12.4 19h9.2" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div>
        <p className="auth-brand-name">Altiora</p>
        <p className="muted small">Pedidos por QR Code</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login } = useSession();
  const { params } = useLocation();
  const from = params.get('de');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!email.trim() || !password) {
      setError('Indique o e-mail e a palavra-passe.');
      return;
    }
    setBusy(true);
    try {
      const user = await login(email.trim(), password);
      navigate(destinationAfterLogin(user, from), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'LOGIN_LOCKED') {
        const min = Math.max(1, Math.ceil((err.retryAfterSec ?? 60) / 60));
        setError(`Demasiadas tentativas. Tente novamente dentro de ${min} ${min === 1 ? 'minuto' : 'minutos'}.`);
      } else {
        setError(errorText(err));
      }
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card stack-lg" onSubmit={submit} noValidate>
        <Brand />
        <div className="stack-sm">
          <h1 className="auth-title voice">Entrar</h1>
          <p className="muted">Acesso reservado à equipa do restaurante.</p>
        </div>
        {error ? (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        ) : null}
        <div className="stack">
          <TextField label="E-mail" type="email" name="email" autoComplete="username" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} required />
          <TextField
            label="Palavra-passe"
            type={show ? 'text' : 'password'}
            name="password"
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <label className="check-row">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span className="check-label">Mostrar a palavra-passe</span>
          </label>
        </div>
        <Button type="submit" size="big" block loading={busy}>
          Entrar
        </Button>
        <p className="muted small center">Esqueceu a palavra-passe? Peça ao gerente do restaurante para a repor.</p>
      </form>
    </div>
  );
}

export function ChangePasswordPage() {
  const { user, reload, logout } = useSession();
  const forced = !!user?.must_change_password;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!current || !next) {
      setError('Preencha todos os campos.');
      return;
    }
    if (next !== again) {
      setError('A confirmação não é igual à nova palavra-passe.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', { current_password: current, new_password: next }, { quiet: true });
      const fresh = await reload();
      setDone(true);
      window.setTimeout(() => navigate(fresh ? HOME[fresh.role as AppRole] : '/entrar', { replace: true }), 900);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card stack-lg" onSubmit={submit} noValidate>
        <Brand />
        <div className="stack-sm">
          <h1 className="auth-title voice">{forced ? 'Escolha a sua palavra-passe' : 'Alterar palavra-passe'}</h1>
          <p className="muted">
            {forced
              ? 'É a sua primeira entrada: a palavra-passe que recebeu é temporária. Escolha uma só sua para continuar.'
              : 'Ao alterar, as sessões abertas noutros aparelhos terminam.'}
          </p>
        </div>
        {done ? (
          <div className="notice notice-ok" role="status">
            Palavra-passe alterada. A abrir o painel…
          </div>
        ) : null}
        {error ? (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        ) : null}
        <div className="stack">
          <TextField label={forced ? 'Palavra-passe temporária' : 'Palavra-passe atual'} type={show ? 'text' : 'password'} autoComplete="current-password" autoCapitalize="none" spellCheck={false} value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <TextField
            label="Nova palavra-passe"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            hint="Pelo menos 10 caracteres, sem o seu e-mail e sem ser uma palavra-passe comum."
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
          <TextField label="Repita a nova palavra-passe" type={show ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={again} onChange={(e) => setAgain(e.target.value)} required />
          <label className="check-row">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span className="check-label">Mostrar as palavras-passe</span>
          </label>
        </div>
        <Button type="submit" size="big" block loading={busy} disabled={done}>
          Guardar palavra-passe
        </Button>
        {forced ? (
          <Button variant="quiet" block onClick={() => void logout()}>
            Sair
          </Button>
        ) : (
          <Button variant="quiet" block onClick={() => window.history.back()}>
            Cancelar
          </Button>
        )}
      </form>
    </div>
  );
}
