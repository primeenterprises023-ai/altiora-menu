import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicOrderView } from '../../../shared/types';
import { CUSTOMER_STATUS_LABEL, type OrderStatus } from '../../../shared/status';
import { ApiError } from '../lib/api';
import { fmtDateTime, kz } from '../lib/format';
import { useLive } from '../lib/live';
import { Link } from '../lib/router';
import { Stream } from '../lib/stream';
import { local } from '../lib/storage';
import { Button } from '../ui/Button';
import { ErrorState, Loading } from '../ui/States';
import { Money } from '../ui/Money';
import { useToast } from '../ui/Toast';
import { LAST_MENU_KEY, publicApi } from './data';
import { applyAccent } from '../lib/theme';

const STEPS: Array<{ status: OrderStatus; label: string }> = [
  { status: 'novo', label: 'Recebido' },
  { status: 'em_preparacao', label: 'A preparar' },
  { status: 'pronto', label: 'Pronto' },
  { status: 'entregue', label: 'Entregue' },
];

const MESSAGE: Record<OrderStatus, string> = {
  novo: 'O restaurante recebeu o seu pedido.',
  em_preparacao: 'A cozinha está a preparar o seu pedido.',
  pronto: 'O seu pedido está pronto e vai a caminho da mesa.',
  entregue: 'Bom apetite! O pedido foi entregue.',
  cancelado: 'Este pedido foi cancelado. Fale com um empregado se precisar de ajuda.',
};

export function OrderPage({ code }: { code: string }) {
  const toast = useToast();
  const stream = useMemo(() => new Stream(`/api/public/orders/${encodeURIComponent(code)}/stream`, ['order.state']), [code]);
  useEffect(() => () => stream.dispose(), [stream]);
  const live = useLive((signal) => publicApi.order(code, signal).then((r) => r.order), { stream, pollMs: 6000, safetyMs: 45_000, resetKey: code });
  const order = live.data;
  const menuPath = local.get(LAST_MENU_KEY);
  const previous = useRef<OrderStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!order) return;
    document.title = `Pedido ${order.order_number} — ${order.restaurant_name}`;
    applyAccent(order.accent_color);
  }, [order]);

  // avisa quando o estado muda (vibração curta no telemóvel); o texto no ecrã é sempre atualizado
  useEffect(() => {
    if (!order) return;
    if (previous.current && previous.current !== order.status && order.status === 'pronto') {
      try {
        navigator.vibrate?.([180, 90, 180]);
      } catch {
        /* sem vibração */
      }
    }
    previous.current = order.status;
  }, [order]);

  const copyLink = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.show('Não foi possível copiar. Guarde o endereço desta página.', 'danger');
    }
  };

  if (live.loading) {
    return (
      <div className="order-page">
        <Loading rows={8} label="A carregar o pedido…" />
      </div>
    );
  }
  if (!order) {
    const notFound = live.error instanceof ApiError && live.error.code === 'ORDER_NOT_FOUND';
    return (
      <div className="order-page">
        {notFound ? (
          <div className="state">
            <h2>Pedido não encontrado</h2>
            <p>Verifique se o endereço está completo ou volte a ler o QR Code da mesa.</p>
          </div>
        ) : (
          <ErrorState error={live.error} onRetry={live.refresh} />
        )}
      </div>
    );
  }

  return (
    <div className="order-page">
      <OrderTicket order={order} live={live.live} offline={!!live.error} />
      <div className="order-actions">
        {menuPath ? (
          <Link className="btn btn-block btn-big" to={menuPath}>
            Voltar ao menu
          </Link>
        ) : null}
        {menuPath ? (
          <Link className="btn btn-secondary btn-block" to={`${menuPath}/pedidos`}>
            Ver todos os pedidos da mesa
          </Link>
        ) : null}
        <Button variant="quiet" block onClick={copyLink}>
          {copied ? 'Endereço copiado' : 'Copiar o endereço deste pedido'}
        </Button>
        <p className="hint center">Para alterar ou cancelar o pedido, fale com um empregado.</p>
      </div>
    </div>
  );
}

function OrderTicket({ order, live, offline }: { order: PublicOrderView; live: boolean; offline: boolean }) {
  const cancelled = order.status === 'cancelado';
  const index = STEPS.findIndex((s) => s.status === order.status);
  const place = `Mesa ${order.table_number}${order.table_label ? `, ${order.table_label}` : ''}`;
  return (
    <article className="ticket ticket-torn order-ticket" aria-labelledby="order-title">
      <p className="order-restaurant voice">{order.restaurant_name}</p>
      <p className="muted order-meta">
        {place} <span aria-hidden="true">·</span> {fmtDateTime(order.created_at)}
      </p>
      <h1 id="order-title" className="order-number voice">
        <span className="order-number-label">Pedido nº</span> {order.order_number}
      </h1>

      <div className={`order-status order-status-${order.status}`} role="status" aria-live="polite">
        <p className="order-status-title voice">{CUSTOMER_STATUS_LABEL[order.status]}</p>
        <p className="order-status-text">{MESSAGE[order.status]}</p>
      </div>

      {!cancelled ? (
        <ol className="steps" aria-label="Progresso do pedido">
          {STEPS.map((s, i) => (
            <li key={s.status} className={`step${i < index ? ' step-done' : ''}${i === index ? ' step-now' : ''}`} aria-current={i === index ? 'step' : undefined}>
              <span className="step-dot" aria-hidden="true" />
              <span className="step-label">{s.label}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <p className="order-link-state muted">{offline ? 'Sem ligação. A tentar de novo…' : live ? 'Atualiza sozinho, em tempo real.' : 'Atualiza sozinho de poucos em poucos segundos.'}</p>

      <hr className="cut-line" />

      <ul className="comanda-lines">
        {order.items.map((it) => (
          <li key={it.id} className="comanda-line">
            <div className="leader comanda-main">
              <span className="lead">
                <b className="num">{it.quantity}×</b> {it.name}
              </span>
              <span className="fill" aria-hidden="true" />
              <span className="tail">
                <Money cents={it.line_total_cents} />
              </span>
            </div>
            {it.options.length > 0 ? <p className="comanda-sub muted">+ {it.options.map((o) => o.name).join(', ')}</p> : null}
            {it.notes ? (
              <p className="comanda-sub">
                <span className="marker">{it.notes}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {order.notes ? (
        <p className="comanda-sub order-notes">
          <span className="muted">Indicação: </span>
          <span className="marker">{order.notes}</span>
        </p>
      ) : null}

      <hr className="cut-line" />
      <div className="comanda-totals">
        {order.service_fee_cents > 0 ? (
          <>
            <div className="leader">
              <span className="lead muted">Subtotal</span>
              <span className="fill" aria-hidden="true" />
              <span className="tail">
                <Money cents={order.subtotal_cents} />
              </span>
            </div>
            <div className="leader">
              <span className="lead muted">Taxa de serviço</span>
              <span className="fill" aria-hidden="true" />
              <span className="tail">
                <Money cents={order.service_fee_cents} />
              </span>
            </div>
          </>
        ) : null}
        <div className="leader comanda-total">
          <span className="lead voice">Total</span>
          <span className="fill" aria-hidden="true" />
          <span className="tail voice">{kz(order.total_cents)}</span>
        </div>
      </div>
    </article>
  );
}
