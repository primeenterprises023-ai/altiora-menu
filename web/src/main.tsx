import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/customer.css';
import './styles/menu.css';
import './styles/viewer.css';
import './styles/staff.css';
import { HistoryPage } from './customer/HistoryPage';
import { Landing } from './customer/Landing';
import { MenuPage, RestaurantPage } from './customer/MenuPage';
import { OrderPage } from './customer/OrderPage';
import { Link, Routes, type RouteDef } from './lib/router';
import { initTheme } from './lib/theme';
import { Loading } from './ui/States';
import { ToastProvider } from './ui/Toast';

// O código da equipa só é descarregado por quem abre os painéis: o cliente do menu recebe o mínimo.
const StaffApp = lazy(() => import('./staff/StaffApp'));
const staff = () => (
  <Suspense
    fallback={
      <div className="boot">
        <Loading rows={5} label="A abrir o painel…" />
      </div>
    }
  >
    <StaffApp />
  </Suspense>
);

const routes: RouteDef[] = [
  { path: '/', render: () => <Landing /> },
  { path: '/r/:slug', render: (p) => <RestaurantPage key={p.slug} slug={p.slug!} /> },
  { path: '/menu/:token', render: (p) => <MenuPage key={p.token} token={p.token!} /> },
  { path: '/menu/:token/pedidos', render: (p) => <HistoryPage key={p.token} token={p.token!} /> },
  { path: '/pedido/:code', render: (p) => <OrderPage key={p.code} code={p.code!} /> },
  { path: '/entrar', render: staff },
  { path: '/alterar-palavra-passe', render: staff },
  { path: '/cozinha/*', render: staff },
  { path: '/empregado/*', render: staff },
  { path: '/gerente/*', render: staff },
  { path: '/plataforma/*', render: staff },
];

function NotFound() {
  return (
    <div className="boot">
      <div className="state">
        <h2>Página não encontrada</h2>
        <p>Este endereço não existe. Se está num restaurante, leia outra vez o QR Code da mesa.</p>
        <a className="btn btn-secondary" href="/">
          Ir para o início
        </a>
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Erro na aplicação:', error.message, info.componentStack);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot">
        <div className="state" role="alert">
          <h2>Algo correu mal</h2>
          <p>Recarregue a página para continuar. Se o problema se repetir, fale com um empregado.</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Recarregar a página
          </button>
        </div>
      </div>
    );
  }
}

initTheme();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <ErrorBoundary>
      <ToastProvider>
        <Routes routes={routes} fallback={<NotFound />} />
      </ToastProvider>
    </ErrorBoundary>,
  );
}
