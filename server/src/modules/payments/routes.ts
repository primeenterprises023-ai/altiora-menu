// Pagamentos: a equipa REGISTA o que o restaurante recebeu (dinheiro, terminal, transferência).
// O sistema não cobra nada nem guarda dados de cartões; e nenhum pedido fica "pago" por ação do cliente.
//   - empregado e gerente registam pagamentos confirmados;
//   - só o gerente isenta um pedido (cortesia), reembolsa ou anula um registo, sempre com motivo (fica na auditoria).
import { PaymentCreateInput, PaymentUpdateInput, uuid } from '../../../../shared/schemas';
import { summarizePayments, type PaymentMethod, type PaymentStatus } from '../../../../shared/payments';
import type { StaffRole } from '../../../../shared/status';
import type { PaymentView } from '../../../../shared/types';
import { iso, num, type Tx } from '../../db/client';
import { audit } from '../../lib/audit';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { created, json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

interface PaymentRow {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: string;
  status: PaymentStatus;
  reference: string | null;
  created_at: Date;
  updated_at: Date;
}

const toView = (r: PaymentRow): PaymentView => ({
  id: r.id,
  order_id: r.order_id,
  method: r.method,
  amount_cents: num(r.amount_cents),
  status: r.status,
  reference: r.reference,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

function staff(ctx: Ctx) {
  const a = ctx.auth!;
  return { role: a.role as StaffRole, restaurantId: a.restaurantId!, userId: a.userId };
}

async function paymentsOf(tx: Tx, orderId: string): Promise<PaymentView[]> {
  const rows = await tx<PaymentRow>`
    SELECT id, order_id, method, amount_cents, status, reference, created_at, updated_at
    FROM payments WHERE order_id = ${orderId} ORDER BY created_at, id`;
  return rows.map(toView);
}

async function list(ctx: Ctx): Promise<Response> {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  const a = staff(ctx);
  const out = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [order] = await tx<{ total_cents: string }>`SELECT total_cents FROM orders WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
    if (!order) return null;
    const payments = await paymentsOf(tx, id.data);
    return { payments, summary: summarizePayments(num(order.total_cents), payments), total_cents: num(order.total_cents) };
  });
  if (!out) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  return json(out);
}

async function record(ctx: Ctx): Promise<Response> {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
  const a = staff(ctx);
  const input = await ctx.body(PaymentCreateInput);

  if (input.status === 'isento') {
    if (a.role !== 'manager') throw forbidden('Só o gerente pode isentar um pedido.', 'EXEMPT_MANAGER_ONLY');
    if (!input.reference || input.reference.length < 3) throw unprocessable('Indique o motivo da isenção.', 'REASON_REQUIRED');
  }

  const out = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    // bloqueia o pedido: dois registos ao mesmo tempo não podem somar mais do que o total
    const [order] = await tx<{ status: string; total_cents: string }>`
      SELECT status, total_cents FROM orders WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!order) throw notFound('Pedido não encontrado.', 'ORDER_NOT_FOUND');
    if (order.status === 'cancelado') throw conflict('Este pedido foi cancelado: não se regista pagamento.', 'ORDER_CANCELLED');
    const total = num(order.total_cents);
    const existing = await paymentsOf(tx, id.data);
    const before = summarizePayments(total, existing);

    let amount: number;
    if (input.status === 'isento') {
      if (before.state === 'isento') throw conflict('Este pedido já está isento.', 'ALREADY_EXEMPT');
      if (before.paid_cents > 0) throw conflict('Este pedido já tem pagamentos registados. Anule-os antes de o isentar.', 'ORDER_HAS_PAYMENTS');
      amount = 0;
    } else {
      if (before.state === 'isento') throw conflict('Este pedido está isento: não leva pagamento.', 'ORDER_EXEMPT');
      if (before.due_cents <= 0) throw conflict('Este pedido já está pago.', 'NOTHING_DUE');
      amount = input.amount_cents ?? before.due_cents;
      if (amount > before.due_cents) {
        throw unprocessable('O valor é superior ao que falta pagar neste pedido.', 'AMOUNT_EXCEEDS_DUE', { due_cents: before.due_cents });
      }
    }

    const [row] = await tx<PaymentRow>`
      INSERT INTO payments (restaurant_id, order_id, method, amount_cents, status, reference, recorded_by)
      VALUES (${a.restaurantId}, ${id.data}, ${input.method}, ${amount}, ${input.status}, ${input.reference}, ${a.userId})
      RETURNING id, order_id, method, amount_cents, status, reference, created_at, updated_at`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: input.status === 'isento' ? 'payment.exempt' : 'payment.record',
      entityType: 'order',
      entityId: id.data,
      metadata: { method: input.method, amount_cents: amount, ...(input.status === 'isento' ? { reason: input.reference } : {}) },
      ip: ctx.ip,
    });
    const payments = [...existing, toView(row!)];
    return { payment: toView(row!), summary: summarizePayments(total, payments) };
  });

  ctx.deps.hub.publishRestaurant(a.restaurantId, { type: 'order.payment', order_id: id.data, at: new Date().toISOString() });
  return created(out);
}

const ALLOWED_CHANGES: Record<string, ReadonlyArray<PaymentStatus>> = {
  pago: ['reembolsado', 'anulado'],
  isento: ['anulado'],
};

/** Só o gerente: reembolsar um pagamento já recebido, ou anular um registo errado (ou uma isenção). */
async function change(ctx: Ctx): Promise<Response> {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Pagamento não encontrado.', 'PAYMENT_NOT_FOUND');
  const a = staff(ctx);
  const input = await ctx.body(PaymentUpdateInput);

  const out = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [cur] = await tx<PaymentRow>`
      SELECT id, order_id, method, amount_cents, status, reference, created_at, updated_at
      FROM payments WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!cur) throw notFound('Pagamento não encontrado.', 'PAYMENT_NOT_FOUND');
    if (!ALLOWED_CHANGES[cur.status]?.includes(input.status)) {
      throw conflict('Este registo não pode passar para esse estado.', 'INVALID_PAYMENT_TRANSITION', { current: cur.status });
    }
    await tx`UPDATE payments SET status = ${input.status} WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: input.status === 'reembolsado' ? 'payment.refund' : 'payment.void',
      entityType: 'payment',
      entityId: id.data,
      metadata: { order_id: cur.order_id, previous: cur.status, amount_cents: num(cur.amount_cents), reason: input.reason },
      ip: ctx.ip,
    });
    const [order] = await tx<{ total_cents: string }>`SELECT total_cents FROM orders WHERE id = ${cur.order_id} AND restaurant_id = ${a.restaurantId}`;
    const payments = await paymentsOf(tx, cur.order_id);
    return {
      orderId: cur.order_id,
      payment: payments.find((p) => p.id === id.data)!,
      summary: summarizePayments(num(order?.total_cents), payments),
    };
  });

  ctx.deps.hub.publishRestaurant(a.restaurantId, { type: 'order.payment', order_id: out.orderId, at: new Date().toISOString() });
  return json({ payment: out.payment, summary: out.summary });
}

export const paymentRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/orders/:id/payments', access: { roles: ['manager', 'waiter'] }, handler: list },
  { method: 'POST', path: '/api/orders/:id/payments', access: { roles: ['manager', 'waiter'] }, handler: record, limits: [{ name: 'payment-record', max: 120, windowMs: 60_000 }] },
  { method: 'PATCH', path: '/api/payments/:id', access: { roles: ['manager'] }, handler: change, limits: [{ name: 'payment-change', max: 60, windowMs: 60_000 }] },
];
