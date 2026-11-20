// Estrutura comum dos painéis: barra do topo, navegação do gerente, conta e aviso de pedidos pausados.
import { Fragment, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FeatureKey } from '../../../shared/plans';
import type { RestaurantSettings } from '../../../shared/types';
import { errorText } from '../lib/api';
import { useLive } from '../lib/live';
import { setCurrency } from '../lib/format';
import { Link, useLocation } from '../lib/router';
import { applyAccent, getTheme, setTheme, type ThemeChoice } from '../lib/theme';
import { Button } from '../ui/Button';
import { SelectField } from '../ui/Fields';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { admin as adminApi, restaurant as restaurantApi } from './data';
import { useFeatures } from './features';
import { useStaffStream } from './hooks';
import { useSession, type AppRole } from './session';

export const ROLE_LABEL: Record<AppRole, string> = {
  manager: 'Gerente',
  waiter: 'Empregado de mesa',
  kitchen: 'Cozinha',
  platform: 'Plataforma',
};

interface RestaurantCtx {
  restaurant: RestaurantSettings | null;
  reload: () => void;
}
const RestaurantContext = createContext<RestaurantCtx>({ restaurant: null, reload: () => undefined });
export const useRestaurant = () => useContext(RestaurantContext);

const MANAGER_NAV: Array<{ to: string; label: string; exact?: boolean; feature?: FeatureKey }> = [
  { to: '/gerente', label: 'Pedidos', exact: true, feature: 'orders' },
  { to: '/gerente/menu', label: 'Menu' },
  { to: '/gerente/mesas', label: 'Mesas e QR Codes' },
  { to: '/gerente/equipa', label: 'Equipa' },
  { to: '/gerente/relatorios', label: 'Relatórios', feature: 'stats' },
  { to: '/gerente/atividade', label: 'Atividade', feature: 'advanced_management' },
  { to: '/gerente/definicoes', label: 'Definições' },
  { to: '/gerente/plano', label: 'Plano' },
];
const PLATFORM_NAV: Array<{ to: string; label: string; exact?: boolean }> = [
  { to: '/plataforma', label: 'Restaurantes', exact: true },
  { to: '/plataforma/planos', label: 'Planos' },
  { to: '/plataforma/contactos', label: 'Contactos' },
];
const MANAGER_VIEWS: Array<{ to: string; label: string }> = [
  { to: '/cozinha', label: 'Ver como cozinha' },
  { to: '/empregado', label: 'Ver como empregado' },
];

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

const THEME_LABEL: Record<ThemeChoice, string> = { auto: 'Automático', light: 'Claro', dark: 'Escuro' };

function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout, switchRestaurant } = useSession();
  const toast = useToast();
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const role = user.role as AppRole;
  const others = user.memberships.filter((m) => m.restaurant_id !== user.restaurant?.id);

  const change = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await switchRestaurant(target);
      onClose();
    } catch (err) {
      toast.show(errorText(err), 'danger');
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="A sua conta">
      <div className="stack-lg">
        <div className="stack-sm">
          <p>
            <strong>{user.name}</strong>
          </p>
          <p className="muted">{user.email}</p>
          <p className="muted">
            {role === 'platform' ? 'Altiora Grupo · plataforma' : ROLE_LABEL[role]}
            {user.restaurant ? ` · ${user.restaurant.name}` : ''}
          </p>
        </div>

        {others.length > 0 ? (
          <div className="stack-sm">
            <SelectField label="Mudar de restaurante" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Escolha…</option>
              {others.map((m) => (
                <option key={m.restaurant_id} value={m.restaurant_id}>
                  {m.restaurant_name} ({ROLE_LABEL[m.role]})
                </option>
              ))}
            </SelectField>
            <Button variant="secondary" onClick={() => void change()} disabled={!target} loading={busy}>
              Mudar
            </Button>
          </div>
        ) : null}

        <fieldset className="stack-sm theme-pick">
          <legend className="label">Aspeto do ecrã</legend>
          <div className="segmented" role="radiogroup" aria-label="Aspeto do ecrã">
            {(['auto', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                className="segment"
                onClick={() => {
                  setTheme(t);
                  setThemeState(t);
                }}
              >
                {THEME_LABEL[t]}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="stack-sm">
          <Link className="btn btn-secondary btn-block" to="/alterar-palavra-passe" onClick={onClose}>
            Alterar palavra-passe
          </Link>
          <Button variant="danger-quiet" block onClick={() => void logout()}>
            Terminar sessão
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const features = useFeatures();
  const { pathname } = useLocation();
  const stream = useStaffStream();
  const toast = useToast();
  const [account, setAccount] = useState(false);
  const [resuming, setResuming] = useState(false);
  const isPlatform = user?.role === 'platform';

  const live = useLive((signal) => restaurantApi.current(signal).then((r) => r.restaurant), { stream, pollMs: 30_000, safetyMs: 120_000, enabled: !isPlatform });
  // contactos comerciais por tratar: o número aparece no separador «Contactos» (só a plataforma)
  const leadsLive = useLive((signal) => adminApi.leads(signal), { pollMs: 60_000, safetyMs: 300_000, enabled: isPlatform });
  const newLeads = isPlatform ? (leadsLive.data?.leads.filter((l) => l.status === 'novo').length ?? 0) : 0;
  const restaurant = live.data ?? null;
  // os valores em dinheiro seguem a moeda do restaurante (Kwanza por omissão); ao mudar, o conteúdo volta a desenhar-se uma vez
  const currency = restaurant?.currency ?? 'AOA';
  setCurrency(currency);

  useEffect(() => {
    applyAccent(restaurant?.accent_color ?? null);
    return () => applyAccent(null);
  }, [restaurant?.accent_color]);

  const ctx = useMemo<RestaurantCtx>(() => ({ restaurant, reload: live.refresh }), [restaurant, live.refresh]);
  if (!user) return null;
  const role = user.role as AppRole;
  const suspended = !!user.restaurant && user.restaurant.status !== 'ativo';

  const resume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await restaurantApi.update({ accepting_orders: true });
      live.refresh();
      toast.show('Pedidos por QR Code retomados.');
    } catch (err) {
      toast.show(errorText(err), 'danger');
    } finally {
      setResuming(false);
    }
  };

  const title = isPlatform ? 'Altiora Grupo' : (restaurant?.name ?? user.restaurant?.name ?? '');
  return (
    <RestaurantContext.Provider value={ctx}>
      <div className="app">
        <header className="appbar">
          <div className="appbar-inner">
            <div className="appbar-brand">
              <span className="appbar-name voice">{title}</span>
              <span className="appbar-role">{ROLE_LABEL[role]}</span>
            </div>
            <button type="button" className="btn btn-quiet btn-sm appbar-account" onClick={() => setAccount(true)} aria-haspopup="dialog">
              {firstName(user.name)}
            </button>
          </div>
          {role === 'platform' ? (
            <nav className="appnav" aria-label="Secções da plataforma">
              <div className="tabs">
                {PLATFORM_NAV.map((n) => {
                  const current = n.exact ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`);
                  return (
                    <Link key={n.to} to={n.to} className="tab" aria-current={current ? 'page' : undefined}>
                      {n.label}
                      {n.to === '/plataforma/contactos' && newLeads > 0 ? (
                        <span className="tab-count" aria-label={`${newLeads} ${newLeads === 1 ? 'novo' : 'novos'}`}>
                          {newLeads}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            </nav>
          ) : null}
          {role === 'manager' ? (
            <nav className="appnav" aria-label="Secções do gerente">
              <div className="tabs">
                {MANAGER_NAV.filter((n) => !n.feature || features.has(n.feature)).map((n) => {
                  const current = n.exact ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`);
                  return (
                    <Link key={n.to} to={n.to} className="tab" aria-current={current ? 'page' : undefined}>
                      {n.label}
                    </Link>
                  );
                })}
                <span className="tabs-gap" aria-hidden="true" />
                {MANAGER_VIEWS.map((n) => (
                  <Link key={n.to} to={n.to} className="tab tab-secondary" aria-current={pathname.startsWith(n.to) ? 'page' : undefined}>
                    {n.label}
                  </Link>
                ))}
              </div>
            </nav>
          ) : null}
        </header>

        {restaurant && !restaurant.accepting_orders && !suspended ? (
          <div className="appbanner notice notice-danger" role="status">
            <span>
              <strong>Pedidos por QR Code pausados.</strong> Os clientes não conseguem enviar pedidos; os pedidos registados pela equipa continuam a funcionar.
            </span>
            {role === 'manager' ? (
              <Button size="sm" variant="secondary" onClick={() => void resume()} loading={resuming}>
                Retomar pedidos
              </Button>
            ) : null}
          </div>
        ) : null}

        <main className="appmain" id="conteudo">
          {suspended ? (
            <div className="state">
              <h2>Restaurante suspenso</h2>
              <p>O acesso deste restaurante está suspenso. Contacte a Altiora Grupo.</p>
            </div>
          ) : (
            <Fragment key={currency}>{children}</Fragment>
          )}
        </main>
        <AccountSheet open={account} onClose={() => setAccount(false)} />
      </div>
    </RestaurantContext.Provider>
  );
}
