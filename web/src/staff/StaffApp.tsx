// Painéis da equipa: entrada, troca de palavra-passe e as áreas de cada perfil (cozinha, empregado, gerente, plataforma).
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Redirect, useLocation } from '../lib/router';
import { Loading } from '../ui/States';
import { ChangePasswordPage, LoginPage, destinationAfterLogin } from './AuthPages';
import { Shell } from './Shell';
import { HOME, SessionProvider, canOpen, useSession, type AppRole } from './session';

// Cada perfil só descarrega o código que usa.
const KitchenPage = lazy(() => import('./kitchen/KitchenPage'));
const WaiterPage = lazy(() => import('./waiter/WaiterPage'));
const ManagerApp = lazy(() => import('./manager/ManagerApp'));
const PlatformApp = lazy(() => import('./platform/PlatformApp'));

function Boot({ label }: { label: string }) {
  return (
    <div className="boot">
      <Loading rows={5} label={label} />
    </div>
  );
}

function Zone({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <Suspense fallback={<Loading rows={5} label="A abrir…" />}>{children}</Suspense>
    </Shell>
  );
}

function StaffRoutes() {
  const { status, user } = useSession();
  const { pathname, search, params } = useLocation();

  if (status === 'loading') return <Boot label="A verificar a sessão…" />;

  if (pathname === '/entrar') {
    if (status === 'ready' && user) return <Redirect to={destinationAfterLogin(user, params.get('de'))} />;
    return <LoginPage />;
  }
  if (status === 'anonymous' || !user) return <Redirect to={`/entrar?de=${encodeURIComponent(pathname + search)}`} />;

  const role = user.role as AppRole;
  if (user.must_change_password && pathname !== '/alterar-palavra-passe') return <Redirect to="/alterar-palavra-passe" />;
  if (pathname === '/alterar-palavra-passe') return <ChangePasswordPage />;
  if (!canOpen(role, pathname)) return <Redirect to={HOME[role]} />;

  if (pathname.startsWith('/cozinha')) return <Zone><KitchenPage /></Zone>;
  if (pathname.startsWith('/empregado')) return <Zone><WaiterPage /></Zone>;
  if (pathname.startsWith('/gerente')) return <Zone><ManagerApp /></Zone>;
  if (pathname.startsWith('/plataforma')) return <Zone><PlatformApp /></Zone>;
  return <Redirect to={HOME[role]} />;
}

export default function StaffApp() {
  // Só quando a equipa abre a sua área: avisos no topo (não tapam os botões de baixo) e ícone/manifesto para instalar no telemóvel.
  useEffect(() => {
    document.body.classList.add('is-staff');
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const added = !link;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      link.href = '/manifest.webmanifest';
      document.head.appendChild(link);
    }
    return () => {
      document.body.classList.remove('is-staff');
      if (added && link) link.remove();
    };
  }, []);
  return (
    <SessionProvider>
      <StaffRoutes />
    </SessionProvider>
  );
}
