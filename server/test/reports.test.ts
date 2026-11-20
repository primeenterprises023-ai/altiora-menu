// Relatórios: vendas registadas (pedidos) e pagamentos confirmados são números diferentes e nunca se misturam;
// os dias contam-se no fuso horário do restaurante; cada gerente só vê o seu restaurante.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, orderBody, seedFullRestaurant, startTestApp, uniqueKey, type TestApp } from './helpers';

let t: TestApp;
let A: Awaited<ReturnType<typeof seedFullRestaurant>>;
let B: Awaited<ReturnType<typeof seedFullRestaurant>>;
let manager: Client;
let managerB: Client;
let waiter: Client;
let kitchen: Client;
let customer: Client;

const TOTAL = 1232000; // 2 muambas com ovo + 1 sumo + 10 % de serviço
const SUMO_ONLY = 132000; // 1 sumo (1200 Kz) + 10 %

beforeAll(async () => {
  t = await startTestApp({ env: { MAX_PENDING_ORDERS_PER_TABLE: '100' } });
  A = await seedFullRestaurant(t, 'Terraza A', 'a', { feeBps: 1000 });
  B = await seedFullRestaurant(t, 'Restaurante B', 'b');
  manager = await t.login(A.emails.manager);
  managerB = await t.login(B.emails.manager);
  waiter = await t.login(A.emails.waiter);
  kitchen = await t.login(A.emails.kitchen);
  customer = t.anon('203.0.113.70');
});
afterAll(async () => {
  await t.close();
});

const place = async (body: unknown = orderBody(A.menu)) => {
  const r = await customer.post(`/api/public/menu/${A.table1.token}/orders`, body, { headers: { 'idempotency-key': uniqueKey() } });
  expect(r.status).toBe(201);
  const list = await manager.get('/api/orders?scope=active&limit=200');
  return list.body.orders.find((o: any) => o.order_number === r.body.order.order_number && o.status === 'novo').id as string;
};
const pay = (id: string, body: Record<string, unknown>, c: Client = waiter) => c.post(`/api/orders/${id}/payments`, body);
const report = (c: Client, qs = '') => c.get(`/api/reports/sales${qs}`);

let paidFull: string;
let partial: string;
let unpaid: string;
let exempt: string;
let cancelled: string;
let refunded: string;

describe('preparação: pedidos com pagamentos em situações diferentes', () => {
  test('cria os pedidos', async () => {
    paidFull = await place();
    partial = await place();
    unpaid = await place();
    exempt = await place();
    cancelled = await place();
    refunded = await place({ items: [{ menu_item_id: A.menu.sumo.id, quantity: 1 }] });

    expect((await pay(paidFull, { method: 'dinheiro' })).status).toBe(201);
    expect((await pay(partial, { method: 'terminal', amount_cents: 500000 })).status).toBe(201);
    expect((await pay(exempt, { method: 'outro', status: 'isento', reference: 'Cortesia' }, manager)).status).toBe(201);
    expect((await manager.post(`/api/order-status/${cancelled}`, { to: 'cancelado', reason: 'Engano do cliente' })).status).toBe(200);
    const rp = await pay(refunded, { method: 'transferencia', reference: 'TR-1' });
    expect((await manager.patch(`/api/payments/${rp.body.payment.id}`, { status: 'reembolsado', reason: 'Pedido devolvido' })).status).toBe(200);
  });
});

describe('vendas registadas e pagamentos confirmados', () => {
  test('por omissão mostra os últimos 7 dias, no fuso do restaurante', async () => {
    const r = await report(manager);
    expect(r.status).toBe(200);
    const rep = r.body.report;
    expect(rep.range.timezone).toBe('Africa/Luanda');
    expect(rep.range.currency).toBe('AOA');
    expect(rep.by_day).toHaveLength(7);
    expect(rep.by_day.at(-1).day).toBe(rep.range.to);
    const today = (await t.db.system(async (tx) => tx<{ d: string }>`SELECT ((now() AT TIME ZONE 'Africa/Luanda')::date)::text AS d`))[0]!.d;
    expect(rep.range.to).toBe(today);
  });

  test('as vendas contam os pedidos não cancelados, mesmo os que ainda ninguém pagou', async () => {
    const { report: rep } = (await report(manager)).body;
    // pagoFull, partial, unpaid, exempt (4 × TOTAL) + refunded (SUMO_ONLY)
    expect(rep.sales.orders).toBe(5);
    expect(rep.sales.total_cents).toBe(4 * TOTAL + SUMO_ONLY);
    expect(rep.sales.subtotal_cents + rep.sales.service_fee_cents).toBe(rep.sales.total_cents);
    expect(rep.sales.average_ticket_cents).toBe(Math.round((4 * TOTAL + SUMO_ONLY) / 5));
    expect(rep.sales.units).toBe(4 * 3 + 1);
    expect(rep.cancelled).toEqual({ orders: 1, total_cents: TOTAL });
  });

  test('os pagamentos confirmados são outro número: só o que a equipa registou como recebido', async () => {
    const { report: rep } = (await report(manager)).body;
    expect(rep.payments.confirmed_cents).toBe(TOTAL + 500000);
    expect(rep.payments.confirmed_cents).not.toBe(rep.sales.total_cents);
    expect(rep.payments.by_method).toEqual([
      { method: 'dinheiro', count: 1, confirmed_cents: TOTAL },
      { method: 'terminal', count: 1, confirmed_cents: 500000 },
    ]);
    // o reembolsado não é dinheiro recebido
    expect(rep.payments.refunded_cents).toBe(SUMO_ONLY);
  });

  test('o que falta receber exclui cancelados e isentos, e desconta o que já foi pago', async () => {
    const { report: rep } = (await report(manager)).body;
    // partial: falta TOTAL - 500000; unpaid: TOTAL; refunded (reembolsado): volta a faltar SUMO_ONLY; paidFull e exempt: nada
    expect(rep.outstanding_cents).toBe(TOTAL - 500000 + TOTAL + SUMO_ONLY);
    expect(rep.exempt_orders).toBe(1);
  });

  test('o dia de hoje junta tudo; os outros dias ficam a zero', async () => {
    const { report: rep } = (await report(manager)).body;
    const today = rep.by_day.at(-1);
    expect(today).toEqual({ day: rep.range.to, orders: 5, total_cents: 4 * TOTAL + SUMO_ONLY, confirmed_cents: TOTAL + 500000 });
    for (const d of rep.by_day.slice(0, -1)) expect(d).toMatchObject({ orders: 0, total_cents: 0, confirmed_cents: 0 });
  });

  test('os pratos mais vendidos (sem cancelados), por quantidade', async () => {
    const { report: rep } = (await report(manager)).body;
    expect(rep.top_items[0]).toMatchObject({ name: 'Muamba de galinha', quantity: 8 }); // 4 pedidos × 2
    expect(rep.top_items[1]).toMatchObject({ name: 'Sumo natural', quantity: 5 });
    expect(rep.top_items[0].total_cents).toBeGreaterThan(0);
  });
});

describe('períodos e fusos horários', () => {
  test('períodos sem pedidos dão zeros, não erros', async () => {
    const r = await report(manager, '?from=2020-01-01&to=2020-01-03');
    expect(r.status).toBe(200);
    expect(r.body.report.by_day.map((d: any) => d.day)).toEqual(['2020-01-01', '2020-01-02', '2020-01-03']);
    expect(r.body.report.sales).toEqual({ orders: 0, units: 0, subtotal_cents: 0, service_fee_cents: 0, total_cents: 0, average_ticket_cents: 0 });
    expect(r.body.report.payments.by_method).toEqual([]);
    expect(r.body.report.top_items).toEqual([]);
  });

  test('datas inválidas e períodos demasiado grandes são recusados', async () => {
    expect((await report(manager, '?from=2026-11-10&to=2026-11-01')).status).toBe(422);
    expect((await report(manager, '?from=2024-01-01&to=2026-11-01')).body.error.code).toBe('RANGE_TOO_LARGE');
    expect((await report(manager, '?from=ontem')).status).toBe(400);
    expect((await report(manager, '?from=2026-13-45&to=2026-13-46')).status).toBe(400);
    expect((await report(manager, '?foo=bar')).status).toBe(400);
  });

  test('um pedido de ontem aparece em ontem e a venda de ontem não entra em hoje', async () => {
    // muda a data de um pedido para ontem (só em teste: normalmente a base de dados não deixa)
    await t.db.system(async (tx) => {
      await tx.unsafe('ALTER TABLE orders DISABLE TRIGGER USER');
      await tx`UPDATE orders SET order_day = order_day - 1 WHERE id = ${unpaid}`;
      await tx.unsafe('ALTER TABLE orders ENABLE TRIGGER USER');
    });
    const { report: rep } = (await report(manager)).body;
    const [yesterday, today] = rep.by_day.slice(-2);
    expect(yesterday).toMatchObject({ orders: 1, total_cents: TOTAL });
    expect(today).toMatchObject({ orders: 4, total_cents: 3 * TOTAL + SUMO_ONLY });
    expect(rep.sales.total_cents).toBe(4 * TOTAL + SUMO_ONLY);
  });

  test('um pagamento registado às 23h30 do dia anterior (hora do restaurante) conta para esse dia', async () => {
    await t.db.system(async (tx) => {
      await tx`
        UPDATE payments SET created_at = (((now() AT TIME ZONE 'Africa/Luanda')::date - 1)::timestamp + time '23:30') AT TIME ZONE 'Africa/Luanda'
        WHERE order_id = ${paidFull}`;
    });
    const { report: rep } = (await report(manager)).body;
    const [yesterday, today] = rep.by_day.slice(-2);
    expect(yesterday.confirmed_cents).toBe(TOTAL);
    expect(today.confirmed_cents).toBe(500000);
    expect(rep.payments.confirmed_cents).toBe(TOTAL + 500000);
  });

  test('o "hoje" por omissão segue o fuso horário configurado no restaurante', async () => {
    const tz = 'Pacific/Kiritimati'; // UTC+14: quase sempre num dia diferente de Luanda
    expect((await manager.patch('/api/restaurants/current', { timezone: tz })).status).toBe(200);
    const expected = (await t.db.system(async (tx) => tx<{ d: string }>`SELECT ((now() AT TIME ZONE ${tz})::date)::text AS d`))[0]!.d;
    const { report: rep } = (await report(manager)).body;
    expect(rep.range.timezone).toBe(tz);
    expect(rep.range.to).toBe(expected);
    expect((await manager.patch('/api/restaurants/current', { timezone: 'Africa/Luanda' })).status).toBe(200);
  });
});

describe('acesso e isolamento', () => {
  test('só o gerente vê relatórios', async () => {
    for (const c of [customer, waiter, kitchen]) expect([401, 403]).toContain((await report(c)).status);
  });

  test('o gerente de outro restaurante não vê nada do restaurante A', async () => {
    const r = await report(managerB);
    expect(r.status).toBe(200);
    expect(r.body.report.sales.orders).toBe(0);
    expect(r.body.report.sales.total_cents).toBe(0);
    expect(r.body.report.payments.confirmed_cents).toBe(0);
    expect(r.body.report.outstanding_cents).toBe(0);
    expect(r.body.report.top_items).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain('Muamba');
  });
});
