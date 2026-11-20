// Relatórios do gerente. Dois números que NÃO se podem confundir:
//   - vendas registadas: pedidos não cancelados (o que foi pedido);
//   - pagamentos confirmados: o que a equipa registou como recebido (dinheiro, terminal, transferência).
// Os dias contam-se no fuso horário do restaurante e os valores estão em cêntimos (Kz).
import { salesCsv } from '../../../../shared/csv';
import { ReportQuery } from '../../../../shared/schemas';
import type { PaymentMethod } from '../../../../shared/payments';
import type { SalesReport } from '../../../../shared/types';
import { num } from '../../db/client';
import { audit } from '../../lib/audit';
import { badRequest, unprocessable } from '../../lib/errors';
import { json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';
import { requireFeature } from '../../lib/plans';

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const dayString = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

function asDay(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

/** Lê e valida o período pedido (por omissão, os últimos 7 dias do restaurante) e calcula o relatório. O plano já foi verificado. */
async function loadReport(ctx: Ctx): Promise<SalesReport> {
  const parsed = ReportQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success) {
    throw badRequest('Datas inválidas.', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })), 'VALIDATION_ERROR');
  }
  const a = ctx.auth!;

  return ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx<{ timezone: string; currency: string; today: string }>`
      SELECT timezone, currency, ((now() AT TIME ZONE timezone)::date)::text AS today FROM restaurants WHERE id = ${a.restaurantId}`;
    const to = parsed.data.to ?? r!.today;
    const from = parsed.data.from ?? dayString(dayNumber(to) - 6);
    if (Number.isNaN(dayNumber(from)) || Number.isNaN(dayNumber(to))) throw badRequest('Datas inválidas.', undefined, 'VALIDATION_ERROR');
    if (dayNumber(from) > dayNumber(to)) throw unprocessable('A data inicial não pode ser depois da final.', 'RANGE_INVALID');
    if (dayNumber(to) - dayNumber(from) + 1 > MAX_DAYS) throw unprocessable(`O período não pode ter mais de ${MAX_DAYS} dias.`, 'RANGE_TOO_LARGE');
    const rid = a.restaurantId!;

    const orderDays = await tx<{ day: Date | string; orders: number; units: string; subtotal: string; fee: string; total: string }>`
      SELECT o.order_day AS day, count(*)::int AS orders,
             coalesce(sum((SELECT sum(i.quantity) FROM order_items i WHERE i.order_id = o.id)), 0) AS units,
             coalesce(sum(o.subtotal_cents), 0) AS subtotal, coalesce(sum(o.service_fee_cents), 0) AS fee, coalesce(sum(o.total_cents), 0) AS total
      FROM orders o
      WHERE o.restaurant_id = ${rid} AND o.order_day BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'
      GROUP BY o.order_day`;

    const [cancelled] = await tx<{ orders: number; total: string }>`
      SELECT count(*)::int AS orders, coalesce(sum(total_cents), 0) AS total
      FROM orders WHERE restaurant_id = ${rid} AND order_day BETWEEN ${from}::date AND ${to}::date AND status = 'cancelado'`;

    const paymentDays = await tx<{ day: Date | string; confirmed: string }>`
      SELECT (p.created_at AT TIME ZONE ${r!.timezone})::date AS day, coalesce(sum(p.amount_cents), 0) AS confirmed
      FROM payments p
      WHERE p.restaurant_id = ${rid} AND p.status = 'pago'
        AND (p.created_at AT TIME ZONE ${r!.timezone})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1`;

    const methods = await tx<{ method: PaymentMethod; count: number; confirmed: string }>`
      SELECT p.method, count(*)::int AS count, coalesce(sum(p.amount_cents), 0) AS confirmed
      FROM payments p
      WHERE p.restaurant_id = ${rid} AND p.status = 'pago'
        AND (p.created_at AT TIME ZONE ${r!.timezone})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY p.method ORDER BY confirmed DESC, p.method`;

    const [refunded] = await tx<{ total: string }>`
      SELECT coalesce(sum(p.amount_cents), 0) AS total
      FROM payments p
      WHERE p.restaurant_id = ${rid} AND p.status = 'reembolsado'
        AND (p.created_at AT TIME ZONE ${r!.timezone})::date BETWEEN ${from}::date AND ${to}::date`;

    const [outstanding] = await tx<{ outstanding: string; exempt_orders: number }>`
      SELECT coalesce(sum(GREATEST(o.total_cents - coalesce(pd.paid, 0), 0)) FILTER (WHERE NOT coalesce(pd.exempt, false)), 0) AS outstanding,
             (count(*) FILTER (WHERE coalesce(pd.exempt, false)))::int AS exempt_orders
      FROM orders o
      LEFT JOIN (
        SELECT order_id, sum(amount_cents) FILTER (WHERE status = 'pago') AS paid, bool_or(status = 'isento') AS exempt
        FROM payments WHERE restaurant_id = ${rid} GROUP BY order_id
      ) pd ON pd.order_id = o.id
      WHERE o.restaurant_id = ${rid} AND o.order_day BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'`;

    const items = await tx<{ name: string; quantity: string; total: string }>`
      SELECT i.item_name_snapshot AS name, sum(i.quantity) AS quantity, sum(i.line_total_cents) AS total
      FROM order_items i JOIN orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
      WHERE o.restaurant_id = ${rid} AND o.order_day BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'
      GROUP BY i.item_name_snapshot ORDER BY sum(i.quantity) DESC, sum(i.line_total_cents) DESC, i.item_name_snapshot LIMIT 10`;

    const orderByDay = new Map(orderDays.map((d) => [asDay(d.day), d]));
    const paidByDay = new Map(paymentDays.map((d) => [asDay(d.day), num(d.confirmed)]));
    const byDay: SalesReport['by_day'] = [];
    for (let n = dayNumber(from); n <= dayNumber(to); n++) {
      const key = dayString(n);
      const o = orderByDay.get(key);
      byDay.push({ day: key, orders: o?.orders ?? 0, total_cents: num(o?.total), confirmed_cents: paidByDay.get(key) ?? 0 });
    }

    const totalOrders = orderDays.reduce((n, d) => n + d.orders, 0);
    const totalCents = orderDays.reduce((n, d) => n + num(d.total), 0);
    const out: SalesReport = {
      range: { from, to, timezone: r!.timezone, currency: r!.currency },
      sales: {
        orders: totalOrders,
        units: orderDays.reduce((n, d) => n + num(d.units), 0),
        subtotal_cents: orderDays.reduce((n, d) => n + num(d.subtotal), 0),
        service_fee_cents: orderDays.reduce((n, d) => n + num(d.fee), 0),
        total_cents: totalCents,
        average_ticket_cents: totalOrders > 0 ? Math.round(totalCents / totalOrders) : 0,
      },
      cancelled: { orders: cancelled!.orders, total_cents: num(cancelled!.total) },
      payments: {
        confirmed_cents: methods.reduce((n, m) => n + num(m.confirmed), 0),
        refunded_cents: num(refunded!.total),
        by_method: methods.map((m) => ({ method: m.method, count: m.count, confirmed_cents: num(m.confirmed) })),
      },
      outstanding_cents: num(outstanding!.outstanding),
      exempt_orders: outstanding!.exempt_orders,
      by_day: byDay,
      top_items: items.map((i) => ({ name: i.name, quantity: num(i.quantity), total_cents: num(i.total) })),
    };
    return out;
  });
}

async function sales(ctx: Ctx): Promise<Response> {
  await requireFeature(ctx.deps.db, ctx.auth!.restaurantId!, 'stats', 'as estatísticas');
  return json({ report: await loadReport(ctx) });
}

/** Exportação em CSV: só com "Gestão avançada" no plano (verificado aqui, não no botão), e fica no registo de atividade. */
async function salesFile(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  await requireFeature(ctx.deps.db, rid, 'stats', 'as estatísticas');
  await requireFeature(ctx.deps.db, rid, 'advanced_management', 'a exportação de relatórios em CSV');
  const report = await loadReport(ctx);
  await ctx.deps.db.as({ role: 'manager', restaurantId: rid, userId: a.userId }, (tx) =>
    audit(tx, { restaurantId: rid, actorId: a.userId, actorRole: a.role, action: 'report.export', entityType: 'report', metadata: { from: report.range.from, to: report.range.to }, ip: ctx.ip }),
  );
  return new Response(salesCsv(report), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="vendas-${report.range.from}_a_${report.range.to}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

const limits = [{ name: 'report', max: 60, windowMs: 60_000 }];
export const reportRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/reports/sales', access: { roles: ['manager'] }, handler: sales, limits },
  { method: 'GET', path: '/api/reports/sales.csv', access: { roles: ['manager'] }, handler: salesFile, limits },
];
