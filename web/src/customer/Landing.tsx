import { useEffect } from 'react';
import { Link } from '../lib/router';
import { applyAccent } from '../lib/theme';

/** Página inicial do endereço: os clientes chegam pelo QR Code da mesa, por isso aqui só se explica isso. */
export function Landing() {
  useEffect(() => {
    applyAccent(null);
    document.title = 'Pedidos por QR Code';
  }, []);
  return (
    <main className="landing">
      <div className="landing-card ticket ticket-torn">
        <svg className="landing-mark" viewBox="0 0 64 64" width="56" height="56" aria-hidden="true" focusable="false">
          <rect width="64" height="64" rx="14" fill="#1b2447" />
          <path d="M19 48 32 15 45 48M24.5 37h15" fill="none" stroke="#f5b800" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1 className="voice">Pedidos por QR Code</h1>
        <p>Para ver o menu e fazer o seu pedido, leia o QR Code que está na sua mesa com a câmara do telemóvel.</p>
        <p className="muted">Não precisa de instalar nada nem de criar conta.</p>
        <hr className="cut-line" />
        <p className="muted landing-staff">
          É da equipa do restaurante? <Link to="/entrar">Entrar</Link>
        </p>
      </div>
    </main>
  );
}
