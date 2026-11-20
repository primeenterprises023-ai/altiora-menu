// Sessão da equipa: quem está dentro, entrar, sair e trocar de restaurante.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StaffRole } from '../../../shared/status';
import type { SessionUser } from '../../../shared/types';
import { api, ApiError, setApiHooks } from '../lib/api';
import { navigate, useLocation } from '../lib/router';
import { closeStaffStream } from './realtime';

export type AppRole = StaffRole | 'platform';

type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'ready'; user: SessionUser };

interface SessionApi {
  status: State['status'];
  user: SessionUser | null;
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  switchRestaurant: (restaurantId: string) => Promise<void>;
  /** Volta a ler os dados da sessão (ex.: depois de trocar a palavra-passe). */
  reload: () => Promise<SessionUser | null>;
}

const Ctx = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession fora do SessionProvider');
  return v;
}

/** Página inicial de cada perfil. */
export const HOME: Record<AppRole, string> = { kitchen: '/cozinha', waiter: '/empregado', manager: '/gerente', platform: '/plataforma' };

/** Que perfis podem abrir cada zona. O gerente também pode usar a cozinha e a sala (o servidor permite-lhe as mesmas ações). */
export function canOpen(role: AppRole, pathname: string): boolean {
  if (pathname.startsWith('/cozinha')) return role === 'kitchen' || role === 'manager';
  if (pathname.startsWith('/empregado')) return role === 'waiter' || role === 'manager';
  if (pathname.startsWith('/gerente')) return role === 'manager';
  if (pathname.startsWith('/plataforma')) return role === 'platform';
  return true;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const location = useLocation();
  const pathRef = useRef(location.pathname + location.search);
  pathRef.current = location.pathname + location.search;

  const goAnonymous = useCallback((keepPath: boolean) => {
    closeStaffStream();
    setState({ status: 'anonymous' });
    const here = pathRef.current;
    const target = keepPath && here !== '/entrar' && !here.startsWith('/entrar?') ? `/entrar?de=${encodeURIComponent(here)}` : '/entrar';
    navigate(target, { replace: true });
  }, []);

  useEffect(() => {
    setApiHooks({
      onUnauthorized: () => goAnonymous(true),
      onPasswordChangeRequired: () => navigate('/alterar-palavra-passe', { replace: true }),
    });
    let cancelled = false;
    api
      .get<{ user: SessionUser }>('/api/auth/me', { quiet: true })
      .then((r) => {
        if (!cancelled) setState({ status: 'ready', user: r.user });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setState({ status: 'anonymous' });
        else setState({ status: 'anonymous' });
      });
    return () => {
      cancelled = true;
      setApiHooks({});
    };
  }, [goAnonymous]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.post<{ user: SessionUser }>('/api/auth/login', { email, password }, { quiet: true });
    closeStaffStream();
    setState({ status: 'ready', user: r.user });
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout', undefined, { quiet: true });
    } catch {
      /* mesmo sem resposta do servidor, este aparelho fica sem sessão */
    }
    closeStaffStream();
    setState({ status: 'anonymous' });
    navigate('/entrar', { replace: true });
  }, []);

  const switchRestaurant = useCallback(async (restaurantId: string) => {
    const r = await api.post<{ user: SessionUser }>('/api/auth/switch-restaurant', { restaurant_id: restaurantId });
    closeStaffStream();
    setState({ status: 'ready', user: r.user });
    navigate(HOME[r.user.role as AppRole], { replace: true });
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await api.get<{ user: SessionUser }>('/api/auth/me', { quiet: true });
      setState({ status: 'ready', user: r.user });
      return r.user;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<SessionApi>(
    () => ({ status: state.status, user: state.status === 'ready' ? state.user : null, login, logout, switchRestaurant, reload }),
    [state, login, logout, switchRestaurant, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
