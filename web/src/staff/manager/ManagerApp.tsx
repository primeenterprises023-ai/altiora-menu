// Área do gerente: cada secção tem o seu endereço (/gerente, /gerente/menu, …).
import { Redirect, Routes } from '../../lib/router';
import { useFeatures } from '../features';
import ActivityPage from './ActivityPage';
import MenuAdminPage from './MenuAdminPage';
import OrdersPage from './OrdersPage';
import PlanPage from './PlanPage';
import QrPrintPage from './QrPrintPage';
import ReportsPage from './ReportsPage';
import SettingsPage from './SettingsPage';
import TablesPage from './TablesPage';
import TeamPage from './TeamPage';

export default function ManagerApp() {
  const features = useFeatures();
  const orders = features.has('orders');
  return (
    <Routes
      routes={[
        // sem pedidos digitais no plano, o gerente começa pelo menu
        { path: '/gerente', render: () => (orders ? <OrdersPage /> : <Redirect to="/gerente/menu" />) },
        { path: '/gerente/menu', render: () => <MenuAdminPage /> },
        { path: '/gerente/mesas', render: () => <TablesPage /> },
        { path: '/gerente/mesas/imprimir', render: () => (features.has('tables') ? <QrPrintPage /> : <Redirect to="/gerente/mesas" />) },
        { path: '/gerente/equipa', render: () => <TeamPage /> },
        { path: '/gerente/atividade', render: () => (features.has('advanced_management') ? <ActivityPage /> : <Redirect to="/gerente/plano" />) },
        { path: '/gerente/relatorios', render: () => (features.has('stats') ? <ReportsPage /> : <Redirect to="/gerente/plano" />) },
        { path: '/gerente/definicoes', render: () => <SettingsPage /> },
        { path: '/gerente/plano', render: () => <PlanPage /> },
      ]}
      fallback={<Redirect to={orders ? '/gerente' : '/gerente/menu'} />}
    />
  );
}
