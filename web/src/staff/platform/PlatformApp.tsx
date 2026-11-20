// Área da Altiora: restaurantes e assinaturas, planos e preços, contactos vindos da página comercial.
import { Redirect, Routes } from '../../lib/router';
import LeadsPage from './LeadsPage';
import PlansPage from './PlansPage';
import PlatformPage from './PlatformPage';

export default function PlatformApp() {
  return (
    <Routes
      routes={[
        { path: '/plataforma', render: () => <PlatformPage /> },
        { path: '/plataforma/planos', render: () => <PlansPage /> },
        { path: '/plataforma/contactos', render: () => <LeadsPage /> },
      ]}
      fallback={<Redirect to="/plataforma" />}
    />
  );
}
