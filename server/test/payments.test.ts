// Pagamentos: só a equipa regista; o cliente nunca marca "pago"; sem pagar a mais; isenções, reembolsos e anulações só pelo gerente.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, orderBody, seedFullRestaurant, startTestApp, uniqueKey, type TestApp } from './helpers';

let t: TestApp;
let A: Awaited<ReturnType<typeof seedFullRestaurant>>;
let B: Awaited<ReturnType<typeof seedFullRestaurant>>;
let manager: Client;
let waiter: Client;
let kitchen: Client;
let managerB: Client;
let customer: Client;

beforeAll(async () => {
  t = await startTestApp({ env: { MAX_PENDING_ORDERS_PER_TABLE: '100' } });
  A = await seedFullRestaurant(t, 'Terraza A', 'a', { feeBps: 1000 });
  B = await seedFullRestaurant(t, 'Restaurante B', 'b');
  manager = await t.login(A.emails.manager);
  waiter = await t.login(A.emails.waiter);
  kitchen = await t.login(A.emails.kitchen);
  managerB = await t.login(B.emails.manager);
  customer = t.anon('203.0.113.50');
});
afterAll(async () => {
  await t.close();
});

/** Faz um pedido pelo QR Code: 2 muambas com ovo (2 × 5000 Kz) + 1 sumo (1200 Kz) = 11 200 Kz + 10 % de serviço = 12 320 Kz. */
async function newOrder(r: typeof A = A, token = r.table1.token): Promise<{ id: string; code: string; total: number }> {
  const placed = await customer.post(`/api/public/menu/${token}/orders`, orderBody(r.menu), { headers: { 'idempotency-key': uniqueKey() } });
  expect(placed.status).toBe(201);
  const list = await (r === A ? manager : managerB).get('/api/orders?scope=active&limit=200');
  const order = list.body.orders.find((o: any) => o.total_cents === placed.body.order.total_cents && o.status === 'novo' && !seen.has(o.id));
  seen.add(order.id);
  return { id: order.id, code: placed.body.order.public_code, total: placed.body.order.total_cents };
}
const seen = new Set<string>();
const pay = (c: Client, orderId: string, body: Record<string, unknown>) => c.post(`/api/orders/${orderId}/payments`, body);

describe('o cliente não regista pagamentos', () => {
  test('o pedido novo está "por pagar" e o cliente não tem forma de o alterar', async () => {
    const o = await newOrder();
    expect(o.total).toBe(1232000);
    const view = await manager.get(`/api/orders/${o.id}`);
    expect(view.body.order.payment).toEqual({ state: 'pendente', paid_cents: 0, due_cents: 1232000 });

    // sem sessão não há acesso, nem leitura nem escrita
    expect((await customer.get(`/api/orders/${o.id}/payments`)).status).toBe(401);
    expect((await pay(customer, o.id, { method: 'dinheiro' })).status).toBe(401);
    // o corpo do pedido do cliente não aceita campos de pagamento
    const sneaky = await customer.post(`/api/public/menu/${A.table1.token}/orders`, { ...orderBody(A.menu), payment_status: 'pago', paid: true }, { headers: { 'idempotency-key': uniqueKey() } });
    expect(sneaky.status).toBe(400);
    // a página pública do pedido não mostra pagamentos
    const pub = await customer.get(`/api/public/orders/${o.code}`);
    expect(JSON.stringify(pub.body)).not.toMatch(/payment|pago/i);
  });

  test('a cozinha não vê nem regista pagamentos', async () => {
    const o = await newOrder();
    const list = await kitchen.get('/api/orders?scope=active&limit=200');
    expect(list.body.orders.every((x: any) => x.payment === null)).toBe(true);
    expect((await kitchen.get(`/api/orders/${o.id}/payments`)).status).toBe(403);
    expect((await pay(kitchen, o.id, { method: 'dinheiro' })).status).toBe(403);
  });
});

describe('registar pagamentos', () => {
  test('o empregado regista o pagamento completo; fica "pago" e o valor assumido é o que faltava', async () => {
    const o = await newOrder();
    const r = await pay(waiter, o.id, { method: 'dinheiro' });
    expect(r.status).toBe(201);
    expect(r.body.payment).toMatchObject({ method: 'dinheiro', amount_cents: o.total, status: 'pago' });
    expect(r.body.summary).toEqual({ state: 'pago', paid_cents: o.total, due_cents: 0 });
    // aparece nas listas do gerente e do empregado
    const list = await manager.get('/api/orders?scope=active&limit=200');
    expect(list.body.orders.find((x: any) => x.id === o.id).payment.state).toBe('pago');
    const wl = await waiter.get(`/api/orders/${o.id}`);
    expect(wl.body.order.payment.state).toBe('pago');
    // fica quem registou
    const row = await t.db.system(async (tx) => (await tx<{ recorded_by: string }>`SELECT recorded_by FROM payments WHERE order_id = ${o.id}`)[0]!);
    expect(row.recorded_by).toBe(A.userIds.waiter);
  });

  test('pagamento em duas partes: parcial e depois pago', async () => {
    const o = await newOrder();
    const first = await pay(manager, o.id, { method: 'terminal', amount_cents: 500000, reference: 'TPA 8841' });
    expect(first.body.summary).toEqual({ state: 'parcial', paid_cents: 500000, due_cents: o.total - 500000 });
    const second = await pay(waiter, o.id, { method: 'transferencia', reference: 'Transf. 20261105-77' });
    expect(second.status).toBe(201);
    expect(second.body.payment.amount_cents).toBe(o.total - 500000);
    expect(second.body.summary.state).toBe('pago');
    const list = await manager.get(`/api/orders/${o.id}/payments`);
    expect(list.body.payments).toHaveLength(2);
    expect(list.body.payments.map((p: any) => p.reference)).toEqual(['TPA 8841', 'Transf. 20261105-77']);
  });

  test('não se paga mais do que falta, nem duas vezes o mesmo pedido', async () => {
    const o = await newOrder();
    const over = await pay(waiter, o.id, { method: 'dinheiro', amount_cents: o.total + 1 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('AMOUNT_EXCEEDS_DUE');
    expect(over.body.error.details.due_cents).toBe(o.total);
    expect((await pay(waiter, o.id, { method: 'dinheiro' })).status).toBe(201);
    const again = await pay(waiter, o.id, { method: 'dinheiro' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOTHING_DUE');
  });

  test('dois registos ao mesmo tempo nunca somam mais do que o total', async () => {
    const o = await newOrder();
    const results = await Promise.all([
      pay(waiter, o.id, { method: 'dinheiro' }),
      pay(manager, o.id, { method: 'terminal' }),
      pay(waiter, o.id, { method: 'dinheiro' }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rows = await t.db.system(async (tx) => tx<{ amount_cents: string }>`SELECT amount_cents FROM payments WHERE order_id = ${o.id}`);
    expect(rows).toHaveLength(1);
  });

  test('dados inválidos são recusados', async () => {
    const o = await newOrder();
    for (const body of [
      {},
      { method: 'cheque' },
      { method: 'dinheiro', amount_cents: 0 },
      { method: 'dinheiro', amount_cents: -5 },
      { method: 'dinheiro', amount_cents: 10.5 },
      { method: 'dinheiro', amount_cents: '1000' },
      { method: 'dinheiro', status: 'reembolsado' },
      { method: 'dinheiro', status: 'pendente' },
      { method: 'dinheiro', reference: 'x'.repeat(101) },
      { method: 'dinheiro', recorded_by: A.userIds.manager },
    ]) {
      expect((await pay(waiter, o.id, body)).status).toBe(400);
    }
    expect((await waiter.get(`/api/orders/${o.id}/payments`)).body.payments).toHaveLength(0);
  });

  test('pedido cancelado não recebe pagamentos', async () => {
    const o = await newOrder();
    expect((await manager.post(`/api/order-status/${o.id}`, { to: 'cancelado', reason: 'Cliente saiu' })).status).toBe(200);
    const r = await pay(waiter, o.id, { method: 'dinheiro' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ORDER_CANCELLED');
  });

  test('pagar não altera o estado do pedido (entrega e pagamento são coisas separadas)', async () => {
    const o = await newOrder();
    await pay(waiter, o.id, { method: 'dinheiro' });
    expect((await manager.get(`/api/orders/${o.id}`)).body.order.status).toBe('novo');
  });
});

describe('isenção, reembolso e anulação: só o gerente, sempre com motivo', () => {
  test('só o gerente isenta, e com motivo', async () => {
    const o = await newOrder();
    const byWaiter = await pay(waiter, o.id, { method: 'outro', status: 'isento', reference: 'Cortesia da casa' });
    expect(byWaiter.status).toBe(403);
    expect(byWaiter.body.error.code).toBe('EXEMPT_MANAGER_ONLY');
    const noReason = await pay(manager, o.id, { method: 'outro', status: 'isento' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const ok = await pay(manager, o.id, { method: 'outro', status: 'isento', reference: 'Cortesia da casa' });
    expect(ok.status).toBe(201);
    expect(ok.body.summary).toEqual({ state: 'isento', paid_cents: 0, due_cents: 0 });
    expect((await pay(waiter, o.id, { method: 'dinheiro' })).body.error.code).toBe('ORDER_EXEMPT');
    expect((await pay(manager, o.id, { method: 'outro', status: 'isento', reference: 'Outra vez' })).body.error.code).toBe('ALREADY_EXEMPT');
    // a isenção fica na auditoria, com o motivo
    const logs = await t.db.system(async (tx) => tx<{ metadata: any }>`SELECT metadata FROM audit_logs WHERE restaurant_id = ${A.restaurantId} AND action = 'payment.exempt' AND entity_id = ${o.id}`);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.metadata.reason).toBe('Cortesia da casa');
  });

  test('não se isenta um pedido que já tem pagamentos', async () => {
    const o = await newOrder();
    await pay(waiter, o.id, { method: 'dinheiro', amount_cents: 100000 });
    const r = await pay(manager, o.id, { method: 'outro', status: 'isento', reference: 'Cortesia' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ORDER_HAS_PAYMENTS');
  });

  test('reembolso: só o gerente, com motivo; o pedido volta a "reembolsado" e pode ser pago de novo', async () => {
    const o = await newOrder();
    const paid = await pay(waiter, o.id, { method: 'terminal', reference: 'TPA 1' });
    const pid = paid.body.payment.id;
    expect((await waiter.patch(`/api/payments/${pid}`, { status: 'reembolsado', reason: 'Prato frio' })).status).toBe(403);
    expect((await manager.patch(`/api/payments/${pid}`, { status: 'reembolsado' })).status).toBe(400);
    expect((await manager.patch(`/api/payments/${pid}`, { status: 'reembolsado', reason: 'ab' })).status).toBe(400);
    expect((await manager.patch(`/api/payments/${pid}`, { status: 'pago', reason: 'Tentativa' })).status).toBe(400);
    const r = await manager.patch(`/api/payments/${pid}`, { status: 'reembolsado', reason: 'Prato frio, devolvido' });
    expect(r.status).toBe(200);
    expect(r.body.payment.status).toBe('reembolsado');
    expect(r.body.summary).toEqual({ state: 'reembolsado', paid_cents: 0, due_cents: o.total });
    // já reembolsado: não se muda outra vez
    expect((await manager.patch(`/api/payments/${pid}`, { status: 'anulado', reason: 'Engano' })).body.error.code).toBe('INVALID_PAYMENT_TRANSITION');
    // o valor em falta pode ser registado de novo
    expect((await pay(waiter, o.id, { method: 'dinheiro' })).body.summary.state).toBe('pago');
    const logs = await t.db.system(async (tx) => tx<{ metadata: any }>`SELECT metadata FROM audit_logs WHERE restaurant_id = ${A.restaurantId} AND action = 'payment.refund' AND entity_id = ${pid}`);
    expect(logs[0]!.metadata).toMatchObject({ reason: 'Prato frio, devolvido', amount_cents: o.total, previous: 'pago' });
  });

  test('anular um registo errado volta a deixar o pedido por pagar; anular uma isenção também', async () => {
    const o = await newOrder();
    const paid = await pay(waiter, o.id, { method: 'dinheiro' });
    const voided = await manager.patch(`/api/payments/${paid.body.payment.id}`, { status: 'anulado', reason: 'Registei no pedido errado' });
    expect(voided.body.summary).toEqual({ state: 'pendente', paid_cents: 0, due_cents: o.total });
    const o2 = await newOrder();
    const ex = await pay(manager, o2.id, { method: 'outro', status: 'isento', reference: 'Cortesia' });
    const r = await manager.patch(`/api/payments/${ex.body.payment.id}`, { status: 'anulado', reason: 'Afinal vai pagar' });
    expect(r.body.summary.state).toBe('pendente');
  });
});

describe('isolamento entre restaurantes', () => {
  test('o gerente de outro restaurante não vê, não regista nem altera pagamentos', async () => {
    const o = await newOrder();
    const paid = await pay(waiter, o.id, { method: 'dinheiro' });
    expect((await managerB.get(`/api/orders/${o.id}/payments`)).status).toBe(404);
    expect((await pay(managerB, o.id, { method: 'dinheiro' })).status).toBe(404);
    expect((await managerB.patch(`/api/payments/${paid.body.payment.id}`, { status: 'anulado', reason: 'Tentativa externa' })).status).toBe(404);
    expect((await manager.get(`/api/orders/${o.id}/payments`)).body.payments[0].status).toBe('pago');
  });

  test('a base de dados também recusa: o perfil do gerente do restaurante B não enxerga pagamentos do A', async () => {
    const rows = await t.db.as({ role: 'manager', restaurantId: B.restaurantId, userId: B.userIds.manager }, async (tx) => tx`SELECT id FROM payments`);
    expect(rows).toHaveLength(0);
    const direct = await t.db
      .as({ role: 'manager', restaurantId: B.restaurantId, userId: B.userIds.manager }, async (tx) => {
        const [any] = await t.db.system((s) => s<{ id: string; order_id: string }>`SELECT id, order_id FROM payments WHERE restaurant_id = ${A.restaurantId} LIMIT 1`);
        return tx`UPDATE payments SET status = 'anulado' WHERE id = ${any!.id} RETURNING id`;
      });
    expect(direct).toHaveLength(0);
  });

  test('um pagamento nunca aponta para um pedido de outro restaurante', async () => {
    const [orderOfA] = await t.db.system((s) => s<{ id: string }>`SELECT id FROM orders WHERE restaurant_id = ${A.restaurantId} LIMIT 1`);
    const attempt = t.db.system((s) => s`
      INSERT INTO payments (restaurant_id, order_id, method, amount_cents, status) VALUES (${B.restaurantId}, ${orderOfA!.id}, 'dinheiro', 100, 'pago')`);
    await expect(attempt).rejects.toThrow();
  });
});

describe('lista "por pagar" (contas em aberto)', () => {
  test('mostra só pedidos com valor por receber, de qualquer estado menos cancelado, e só para empregado e gerente', async () => {
    const open = await newOrder(); // novo, por pagar
    const half = await newOrder();
    await pay(waiter, half.id, { method: 'dinheiro', amount_cents: 100000 });
    const paid = await newOrder();
    await pay(waiter, paid.id, { method: 'terminal' });
    const exempt = await newOrder();
    await pay(manager, exempt.id, { method: 'outro', status: 'isento', reference: 'Cortesia da casa' });
    const cancelled = await newOrder();
    await manager.post(`/api/order-status/${cancelled.id}`, { to: 'cancelado', reason: 'Cliente saiu' });
    const delivered = await newOrder();
    await manager.post(`/api/order-status/${delivered.id}`, { to: 'em_preparacao' });
    await manager.post(`/api/order-status/${delivered.id}`, { to: 'pronto' });
    await waiter.post(`/api/order-status/${delivered.id}`, { to: 'entregue' });

    const res = await waiter.get('/api/orders?unpaid=1&limit=200');
    expect(res.status).toBe(200);
    const ids = res.body.orders.map((o: any) => o.id);
    expect(ids).toContain(open.id);
    expect(ids).toContain(half.id); // pago em parte: ainda falta receber
    expect(ids).toContain(delivered.id); // entregue mas por pagar
    expect(ids).not.toContain(paid.id);
    expect(ids).not.toContain(exempt.id);
    expect(ids).not.toContain(cancelled.id);
    expect(res.body.orders.every((o: any) => o.payment.due_cents > 0)).toBe(true);
    expect(res.body.orders.find((o: any) => o.id === half.id).payment).toMatchObject({ state: 'parcial', paid_cents: 100000 });

    // mais recentes primeiro
    const times = res.body.orders.map((o: any) => Date.parse(o.created_at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);

    // o gerente vê o mesmo; a cozinha não tem acesso a pagamentos
    const m = await manager.get('/api/orders?unpaid=1&limit=200');
    expect(m.body.orders.map((o: any) => o.id)).toEqual(ids);
    expect((await kitchen.get('/api/orders?unpaid=1')).status).toBe(403);
    expect((await customer.get('/api/orders?unpaid=1')).status).toBe(401);
    // valores inválidos são recusados
    expect((await manager.get('/api/orders?unpaid=talvez')).status).toBe(400);
  });

  test('nunca mostra pedidos de outro restaurante', async () => {
    const own = await newOrder(A);
    const other = await newOrder(B);
    const a = await manager.get('/api/orders?unpaid=1&limit=200');
    const b = await managerB.get('/api/orders?unpaid=1&limit=200');
    expect(a.body.orders.map((o: any) => o.id)).toContain(own.id);
    expect(a.body.orders.map((o: any) => o.id)).not.toContain(other.id);
    expect(b.body.orders.map((o: any) => o.id)).toContain(other.id);
    expect(b.body.orders.map((o: any) => o.id)).not.toContain(own.id);
  });
});
