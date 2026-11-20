import { useState } from 'react';
import { METHOD_LABEL, PAYMENT_STATE_LABEL, PAYMENT_STATUS_LABEL } from '../../../../shared/payments';
import { STATUS_LABEL, canTransition, nextAction, type OrderStatus, type StaffRole } from '../../../../shared/status';
import type { OrderView, PaymentView } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { fmtDateTime, fmtTime } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { orders, payments } from '../data';
import { useStaffStream } from '../hooks';
import { useRestaurant } from '../Shell';
import { OrderItems } from './OrderCard';
import { PaymentSheet } from './PaymentSheet';
import { ReasonSheet } from './ReasonSheet';

const WHO: Record<string, string> = { manager: 'Gerente', waiter: 'Empregado', kitchen: 'Cozinha', system: 'Sistema' };

interface Props {
  orderId: string | null;
  role: StaffRole;
  onClose: () => void;
  /** Chamado depois de qualquer alteração (para a lista por trás se atualizar já). */
  onChanged?: () => void;
}

type ReasonAction =
  | { kind: 'cancel' }
  | { kind: 'correct'; to: OrderStatus }
  | { kind: 'exempt' }
  | { kind: 'void'; payment: PaymentView }
  | { kind: 'refund'; payment: PaymentView };

/** O primeiro passo "para trás" que o gerente pode dar (corrigir um engano). */
function correctionTarget(status: OrderStatus): OrderStatus | null {
  const to: Partial<Record<OrderStatus, OrderStatus>> = { em_preparacao: 'novo', pronto: 'em_preparacao', entregue: 'pronto', cancelado: 'novo' };
  const target = to[status];
  return target && canTransition('manager', status, target) ? target : null;
}

export function OrderSheet({ orderId, role, onClose, onChanged }: Props) {
  const stream = useStaffStream();
  const toast = useToast();
  const { restaurant } = useRestaurant();
  const tz = restaurant?.timezone;
  const canPay = role === 'manager' || role === 'waiter';
  const open = orderId !== null;

  const detail = useLive((signal) => orders.detail(orderId!, signal), { stream, enabled: open, resetKey: orderId ?? '', pollMs: 6000, safetyMs: 45_000 });
  const pay = useLive((signal) => payments.list(orderId!, signal), { stream, enabled: open && canPay, resetKey: orderId ?? '', pollMs: 8000, safetyMs: 60_000 });

  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<ReasonAction | null>(null);
  const [paying, setPaying] = useState(false);

  const order: OrderView | undefined = detail.data?.order;
  const history = detail.data?.history ?? [];
  const records = pay.data?.payments ?? [];
  const summary = pay.data?.summary ?? order?.payment ?? null;

  const changed = () => {
    detail.refresh();
    pay.refresh();
    onChanged?.();
  };

  const move = async (to: OrderStatus, reason?: string) => {
    if (!order || busy) return;
    setBusy(true);
    try {
      await orders.changeStatus(order.id, { to, from: order.status, ...(reason ? { reason } : {}) });
      changed();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STATE_CONFLICT') {
        toast.show('Este pedido já foi alterado por outra pessoa. Os dados foram atualizados.', 'danger');
        changed();
      } else {
        toast.show(errorText(err), 'danger');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmReason = async (reason: string) => {
    const action = reasonFor;
    if (!action || !order) return;
    if (action.kind === 'cancel') {
      await orders.changeStatus(order.id, { to: 'cancelado', from: order.status, reason });
    } else if (action.kind === 'correct') {
      await orders.changeStatus(order.id, { to: action.to, from: order.status, reason });
    } else if (action.kind === 'exempt') {
      await payments.record(order.id, { method: 'outro', status: 'isento', reference: reason });
    } else if (action.kind === 'void') {
      await payments.change(action.payment.id, { status: 'anulado', reason });
    } else {
      await payments.change(action.payment.id, { status: 'reembolsado', reason });
    }
    setReasonFor(null);
    changed();
  };

  const next = order ? nextAction(role, order.status) : null;
  const correction = order && role === 'manager' ? correctionTarget(order.status) : null;
  const canCancel = !!order && role === 'manager' && canTransition('manager', order.status, 'cancelado');
  const cancelled = order?.status === 'cancelado';
  const due = summary?.due_cents ?? 0;
  const canRecord = canPay && !!order && !cancelled && !!summary && summary.state !== 'isento' && due > 0;
  const canExempt = role === 'manager' && !!order && !cancelled && !!summary && summary.state !== 'isento' && summary.paid_cents === 0;

  const reasonCopy = (a: ReasonAction): { title: string; description: string; confirm: string; danger: boolean; maxLength?: number } => {
    switch (a.kind) {
      case 'cancel':
        return { title: `Cancelar o pedido #${order?.order_number}`, description: 'O cliente vê "Cancelado" e a cozinha deixa de o ver. O motivo fica registado no histórico.', confirm: 'Cancelar pedido', danger: true };
      case 'correct':
        return {
          title: `Corrigir o estado do pedido #${order?.order_number}`,
          description: `O pedido passa de «${STATUS_LABEL[order!.status]}» para «${STATUS_LABEL[a.to]}». Use só para corrigir um engano; o motivo fica registado.`,
          confirm: `Passar para «${STATUS_LABEL[a.to]}»`,
          danger: false,
        };
      case 'exempt':
        return { title: 'Isentar o pedido (cortesia)', description: 'O pedido deixa de ter valor a receber. O motivo fica registado e só o gerente o pode fazer.', confirm: 'Isentar pedido', danger: false, maxLength: 100 };
      case 'void':
        return { title: 'Anular este registo', description: 'Use quando o registo foi feito por engano. O pedido volta a ficar por pagar. O motivo fica registado.', confirm: 'Anular registo', danger: true };
      case 'refund':
        return { title: 'Reembolsar este pagamento', description: 'Regista que o dinheiro foi devolvido ao cliente. O sistema não devolve dinheiro: faça a devolução e registe aqui. O motivo fica guardado.', confirm: 'Registar reembolso', danger: true };
    }
  };
  const rc = reasonFor ? reasonCopy(reasonFor) : null;

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        wide
        title={order ? `Pedido #${order.order_number} · Mesa ${order.table_number}${order.table_label ? ` (${order.table_label})` : ''}` : 'Pedido'}
        footer={
          order && (next || correction || canCancel) ? (
            <div className="stack-sm">
              {next ? (
                <Button size="big" block loading={busy} onClick={() => void move(next.to)}>
                  {next.label}
                </Button>
              ) : null}
              {correction || canCancel ? (
                <div className="row-wrap sheet-foot-secondary">
                  {correction ? (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setReasonFor({ kind: 'correct', to: correction })}>
                      {cancelled ? 'Reabrir pedido' : `Voltar para «${STATUS_LABEL[correction]}»`}
                    </Button>
                  ) : null}
                  {canCancel ? (
                    <Button variant="danger-quiet" size="sm" disabled={busy} onClick={() => setReasonFor({ kind: 'cancel' })}>
                      Cancelar pedido
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {!order ? (
          detail.error ? (
            <div className="notice notice-danger" role="alert">
              {detail.error.message}
            </div>
          ) : (
            <p className="muted">A carregar…</p>
          )
        ) : (
          <div className="stack-lg order-detail">
            <div className="row-wrap">
              <StatusBadge status={order.status} />
              <span className="muted">Feito em {fmtDateTime(order.created_at, tz)}</span>
              {order.source === 'staff' ? <Badge tone="plain">Registado pela equipa</Badge> : null}
            </div>
            {order.cancel_reason ? (
              <div className="notice notice-danger">
                <strong>Motivo do cancelamento:</strong> {order.cancel_reason}
              </div>
            ) : null}

            <section className="stack-sm" aria-label="Itens do pedido">
              <OrderItems items={order.items} prices />
              {order.notes ? (
                <p className="oc-order-note">
                  <span className="oc-note-label">Nota do pedido</span>
                  <span className="marker">{order.notes}</span>
                </p>
              ) : null}
              <div className="totals">
                <div className="leader">
                  <span className="lead muted">Subtotal</span>
                  <span className="fill" aria-hidden="true" />
                  <Money className="tail" cents={order.subtotal_cents} />
                </div>
                {order.service_fee_cents > 0 ? (
                  <div className="leader">
                    <span className="lead muted">Taxa de serviço</span>
                    <span className="fill" aria-hidden="true" />
                    <Money className="tail" cents={order.service_fee_cents} />
                  </div>
                ) : null}
                <div className="leader total-row">
                  <span className="lead">Total</span>
                  <span className="fill" aria-hidden="true" />
                  <Money className="tail" cents={order.total_cents} />
                </div>
              </div>
            </section>

            {canPay ? (
              <section className="stack-sm" aria-label="Pagamento">
                <h3 className="section-title">Pagamento</h3>
                {cancelled ? (
                  <p className="muted">Pedido cancelado: não há pagamento a registar.</p>
                ) : summary ? (
                  <>
                    <div className="row-wrap">
                      <Badge tone={summary.state === 'pago' || summary.state === 'isento' ? 'ok' : summary.state === 'parcial' ? 'warn' : 'plain'}>{PAYMENT_STATE_LABEL[summary.state]}</Badge>
                      <span className="muted">
                        Recebido <Money cents={summary.paid_cents} />
                        {summary.due_cents > 0 ? (
                          <>
                            {' '}· Falta <Money cents={summary.due_cents} />
                          </>
                        ) : null}
                      </span>
                    </div>
                    {records.length > 0 ? (
                      <ul className="pay-list">
                        {records.map((p) => (
                          <li key={p.id} className={`pay-row pay-${p.status}`}>
                            <div className="grow">
                              <p>
                                <strong>{p.status === 'isento' ? 'Isento' : METHOD_LABEL[p.method]}</strong>{' '}
                                {p.status !== 'isento' ? <Money cents={p.amount_cents} /> : null}{' '}
                                <Badge tone={p.status === 'pago' ? 'ok' : p.status === 'isento' ? 'ok' : 'plain'}>{PAYMENT_STATUS_LABEL[p.status]}</Badge>
                              </p>
                              <p className="muted small">
                                {fmtDateTime(p.created_at, tz)}
                                {p.reference ? ` · ${p.reference}` : ''}
                              </p>
                            </div>
                            {role === 'manager' && (p.status === 'pago' || p.status === 'isento') ? (
                              <div className="row-wrap">
                                {p.status === 'pago' ? (
                                  <Button variant="secondary" size="sm" onClick={() => setReasonFor({ kind: 'refund', payment: p })}>
                                    Reembolsar
                                  </Button>
                                ) : null}
                                <Button variant="danger-quiet" size="sm" onClick={() => setReasonFor({ kind: 'void', payment: p })}>
                                  {p.status === 'isento' ? 'Anular isenção' : 'Anular'}
                                </Button>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {canRecord || canExempt ? (
                      <div className="row-wrap">
                        {canRecord ? (
                          <Button variant="secondary" onClick={() => setPaying(true)}>
                            Registar pagamento
                          </Button>
                        ) : null}
                        {canExempt ? (
                          <Button variant="quiet" onClick={() => setReasonFor({ kind: 'exempt' })}>
                            Isentar (cortesia)
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : pay.error ? (
                  <p className="muted">{pay.error.message}</p>
                ) : (
                  <p className="muted">A carregar…</p>
                )}
              </section>
            ) : null}

            <section className="stack-sm" aria-label="Histórico do pedido">
              <h3 className="section-title">Histórico</h3>
              <ol className="timeline">
                {history.map((h, i) => (
                  <li key={i}>
                    <span className="tl-time num">{fmtTime(h.created_at, tz)}</span>
                    <span className="tl-text">
                      {h.previous_status === null ? (
                        <>Pedido recebido{order.source === 'qr' ? ' pelo QR Code' : ' pela equipa'}</>
                      ) : (
                        <>
                          {STATUS_LABEL[h.previous_status]} → <strong>{STATUS_LABEL[h.new_status]}</strong>
                          {h.changed_by_role ? <span className="muted"> · {WHO[h.changed_by_role] ?? h.changed_by_role}</span> : null}
                        </>
                      )}
                      {h.reason ? <span className="tl-reason muted">Motivo: {h.reason}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </Sheet>

      <PaymentSheet order={paying && order ? order : null} dueCents={due} onClose={() => setPaying(false)} onRecorded={changed} />
      <ReasonSheet
        open={reasonFor !== null}
        title={rc?.title ?? ''}
        description={rc?.description}
        confirmLabel={rc?.confirm ?? ''}
        danger={rc?.danger}
        maxLength={rc?.maxLength}
        onClose={() => setReasonFor(null)}
        onConfirm={confirmReason}
      />
    </>
  );
}
