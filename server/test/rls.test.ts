// Segurança na própria base de dados: perfis, RLS (isolamento entre restaurantes), permissões por coluna e regras de estado.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ORDER_STATUSES, canTransition } from '../../shared/status';
import { pgCode, type DbContext, type DbRole, type Tx } from '../src/db/client';
import { orderBody, seedFullRestaurant, startTestApp, uniqueKey, type TestApp } from './helpers';

let t: TestApp;
let A: Awaited<ReturnType<typeof seedFullRestaurant>>;
let B: Awaited<ReturnType<typeof seedFullRestaurant>>;
let orderA: { id: string; code: string };
let orderB: { id: string; code: string };

const ctxOf = (role: DbRole, r: typeof A, extra: Partial<DbContext> = {}): DbContext => ({
  role,
  restaurantId: r.restaurantId,
  userId: role === 'public' ? undefined : r.userIds[role === 'platform' ? 'manager' : role],
  ...extra,
});

/** Executa `fn` no contexto indicado e devolve o código SQLSTATE do erro (ou null se não houve erro). */
async function sqlstate(ctx: DbContext, fn: (tx: Tx) => Promise<unknown>): Promise<string | null> {
  try {
    await t.db.as(ctx, fn);
    return null;
  } catch (err) {
    return pgCode(err) ?? `erro:${(err as Error).message}`;
  }
}

/** Igual a sqlstate(), mas com o utilizador de ligação (dono das tabelas, sem RLS). */
async function sqlstateSystem(fn: (tx: Tx) => Promise<unknown>): Promise<string | null> {
  try {
    await t.db.system(fn);
    return null;
  } catch (err) {
    return pgCode(err) ?? `erro:${(err as Error).message}`;
  }
}

beforeAll(async () => {
  t = await startTestApp();
  A = await seedFullRestaurant(t, 'Restaurante A', 'a');
  B = await seedFullRestaurant(t, 'Restaurante B', 'b');
  const customer = t.anon('198.51.100.7');
  const make = async (r: typeof A) => {
    const res = await customer.post(`/api/public/menu/${r.table1.token}/orders`, orderBody(r.menu), { headers: { 'idempotency-key': uniqueKey() } });
    expect(res.status).toBe(201);
    const id = await t.db.system(async (tx) => (await tx<{ id: string }>`SELECT id FROM orders WHERE public_code = ${res.body.order.public_code}`)[0]!.id);
    return { id, code: res.body.order.public_code as string };
  };
  orderA = await make(A);
  orderB = await make(B);
  await t.db.system(async (tx) => {
    for (const [r, o] of [[A, orderA], [B, orderB]] as const) {
      await tx`INSERT INTO payments (restaurant_id, order_id, method, amount_cents, status, recorded_by) VALUES (${r.restaurantId}, ${o.id}, 'dinheiro', 1000, 'pendente', ${r.userIds.waiter})`;
      await tx`INSERT INTO audit_logs (restaurant_id, actor_id, actor_role, action) VALUES (${r.restaurantId}, ${r.userIds.manager}, 'manager', 'teste.acao')`;
    }
    await tx`INSERT INTO audit_logs (restaurant_id, actor_id, actor_role, action) VALUES (${A.restaurantId}, NULL, 'platform', 'platform.teste')`;
  });
});
afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------------------------
describe('isolamento por restaurante (RLS)', () => {
  const readable: Record<DbRole, Array<[string, string]>> = {
    public: [['restaurants', 'id'], ['categories', 'restaurant_id'], ['menu_items', 'restaurant_id'], ['menu_item_options', 'restaurant_id'], ['table_sessions', 'restaurant_id'], ['orders', 'restaurant_id'], ['order_items', 'restaurant_id'], ['order_item_options', 'restaurant_id']],
    kitchen: [['restaurants', 'id'], ['categories', 'restaurant_id'], ['menu_items', 'restaurant_id'], ['menu_item_options', 'restaurant_id'], ['restaurant_tables', 'restaurant_id'], ['table_sessions', 'restaurant_id'], ['orders', 'restaurant_id'], ['order_items', 'restaurant_id'], ['order_item_options', 'restaurant_id'], ['order_status_history', 'restaurant_id']],
    waiter: [['restaurants', 'id'], ['categories', 'restaurant_id'], ['menu_items', 'restaurant_id'], ['menu_item_options', 'restaurant_id'], ['restaurant_tables', 'restaurant_id'], ['table_sessions', 'restaurant_id'], ['orders', 'restaurant_id'], ['order_items', 'restaurant_id'], ['order_item_options', 'restaurant_id'], ['order_status_history', 'restaurant_id'], ['payments', 'restaurant_id']],
    manager: [['restaurants', 'id'], ['restaurant_members', 'restaurant_id'], ['categories', 'restaurant_id'], ['menu_items', 'restaurant_id'], ['menu_item_options', 'restaurant_id'], ['restaurant_tables', 'restaurant_id'], ['table_sessions', 'restaurant_id'], ['orders', 'restaurant_id'], ['order_items', 'restaurant_id'], ['order_item_options', 'restaurant_id'], ['order_status_history', 'restaurant_id'], ['payments', 'restaurant_id'], ['audit_logs', 'restaurant_id']],
    platform: [],
  };

  for (const role of ['public', 'kitchen', 'waiter', 'manager'] as const) {
    test(`${role}: só vê linhas do restaurante do seu contexto (A e B separados)`, async () => {
      for (const [table, col] of readable[role]) {
        for (const [mine, other] of [[A, B], [B, A]] as const) {
          const extra = role === 'public' ? { tableId: mine.table1.id } : {};
          const rows = await t.db.as(ctxOf(role, mine, extra), (tx) => tx.unsafe<{ rid: string }>(`SELECT DISTINCT ${col}::text AS rid FROM ${table}`));
          const ids = rows.map((r) => r.rid);
          expect(ids.filter((id) => id === other.restaurantId)).toEqual([]);
          if (role !== 'public' && ['categories', 'menu_items', 'restaurant_tables', 'orders'].includes(table)) expect(ids).toEqual([mine.restaurantId]);
        }
      }
    });

    test(`${role}: sem restaurante no contexto não vê nenhuma linha`, async () => {
      for (const [table] of readable[role]) {
        const n = await t.db.as({ role }, async (tx) => (await tx.unsafe<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n);
        expect(n).toBe(0);
      }
    });
  }

  test('tabelas privadas (users, sessions, order_counters, schema_migrations) estão fechadas a todos os perfis', async () => {
    for (const role of ['public', 'kitchen', 'waiter', 'manager', 'platform'] as const) {
      for (const table of ['users', 'sessions', 'order_counters', 'schema_migrations']) {
        const code = await sqlstate(ctxOf(role, A), (tx) => tx.unsafe(`SELECT * FROM ${table} LIMIT 1`));
        expect({ role, table, code }).toEqual({ role, table, code: '42501' });
      }
    }
  });

  test('o perfil de plataforma não lê pedidos, menus, mesas, equipa nem pagamentos', async () => {
    for (const table of ['orders', 'order_items', 'menu_items', 'categories', 'restaurant_tables', 'restaurant_members', 'payments', 'order_status_history', 'table_sessions']) {
      const code = await sqlstate({ role: 'platform' }, (tx) => tx.unsafe(`SELECT 1 FROM ${table} LIMIT 1`));
      expect({ table, code }).toEqual({ table, code: '42501' });
    }
  });

  test('plataforma vê todos os restaurantes e só os registos de auditoria "platform.*"', async () => {
    await t.db.as({ role: 'platform' }, async (tx) => {
      const n = (await tx<{ n: number }>`SELECT count(*)::int AS n FROM restaurants`)[0]!.n;
      expect(n).toBe(2);
      const actions = (await tx<{ action: string }>`SELECT action FROM audit_logs`).map((r) => r.action);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((a) => a.startsWith('platform.'))).toBe(true);
    });
    expect(await sqlstate({ role: 'platform' }, (tx) => tx`DELETE FROM restaurants WHERE id = ${A.restaurantId}`)).toBe('42501');
  });

  test('gerente de A não consegue escrever em B (INSERT recusado; UPDATE/DELETE não afetam linhas)', async () => {
    const ctx = ctxOf('manager', A);
    expect(await sqlstate(ctx, (tx) => tx`INSERT INTO categories (restaurant_id, name) VALUES (${B.restaurantId}, 'intruso')`)).toBe('42501');
    expect(await sqlstate(ctx, (tx) => tx`INSERT INTO restaurant_tables (restaurant_id, table_number, qr_token) VALUES (${B.restaurantId}, 99, ${'z'.repeat(22)})`)).toBe('42501');
    await t.db.as(ctx, async (tx) => {
      expect((await tx`UPDATE menu_items SET name = 'hackeado' WHERE restaurant_id = ${B.restaurantId} RETURNING id`).length).toBe(0);
      expect((await tx`DELETE FROM restaurant_tables WHERE restaurant_id = ${B.restaurantId} RETURNING id`).length).toBe(0);
      expect((await tx`UPDATE restaurants SET name = 'hackeado' WHERE id = ${B.restaurantId} RETURNING id`).length).toBe(0);
    });
    const name = await t.db.system(async (tx) => (await tx<{ name: string }>`SELECT name FROM restaurants WHERE id = ${B.restaurantId}`)[0]!.name);
    expect(name).toBe('Restaurante B');
  });

  test('não se pode mudar uma linha para o restaurante de outro (WITH CHECK)', async () => {
    const code = await sqlstate(ctxOf('manager', A), (tx) => tx`UPDATE categories SET restaurant_id = ${B.restaurantId} WHERE restaurant_id = ${A.restaurantId}`);
    expect(code).toBe('42501');
  });

  test('chaves estrangeiras compostas impedem misturar restaurantes (mesmo com acesso total)', async () => {
    // prato de A com categoria de B
    expect(await sqlstateSystem((tx) => tx`INSERT INTO menu_items (restaurant_id, category_id, name, price_cents) VALUES (${A.restaurantId}, ${B.menu.categoryId}, 'misto', 100)`)).toBe('23503');
    // pedido de A numa mesa de B (recusado já pelo gatilho que numera o pedido)
    expect(await sqlstateSystem((tx) => tx`INSERT INTO orders (restaurant_id, table_id, public_code, subtotal_cents, service_fee_cents, total_cents) VALUES (${A.restaurantId}, ${B.table1.id}, ${'q'.repeat(22)}, 0, 0, 0)`)).toBe('AL006');
    // linha de pedido de A com um prato de B
    expect(await sqlstateSystem((tx) => tx`INSERT INTO order_items (restaurant_id, order_id, menu_item_id, item_name_snapshot, unit_price_snapshot_cents, quantity, line_total_cents)
      VALUES (${A.restaurantId}, ${orderA.id}, ${B.menu.sumo.id}, 'misto', 0, 1, 0)`)).toBe('23503');
    // extra de B numa linha de A
    const lineA = await t.db.system(async (tx) => (await tx<{ id: string }>`SELECT id FROM order_items WHERE order_id = ${orderA.id} LIMIT 1`)[0]!.id);
    expect(await sqlstateSystem((tx) => tx`INSERT INTO order_item_options (restaurant_id, order_item_id, option_id, option_name_snapshot, price_delta_snapshot_cents)
      VALUES (${A.restaurantId}, ${lineA}, ${B.menu.extraOvo.id}, 'misto', 0)`)).toBe('23503');
  });
});

// ---------------------------------------------------------------------------------------------
describe('permissões por coluna', () => {
  test('cozinha e empregado não leem o token do QR Code; o gerente lê', async () => {
    for (const role of ['kitchen', 'waiter'] as const) {
      expect(await sqlstate(ctxOf(role, A), (tx) => tx`SELECT qr_token FROM restaurant_tables`)).toBe('42501');
      expect(await sqlstate(ctxOf(role, A), (tx) => tx`SELECT id, table_number, label, active FROM restaurant_tables`)).toBeNull();
    }
    const rows = await t.db.as(ctxOf('manager', A), (tx) => tx<{ qr_token: string }>`SELECT qr_token FROM restaurant_tables`);
    expect(rows.length).toBe(2);
  });

  test('o cliente (público) não lê a tabela de mesas, nem colunas internas dos pedidos', async () => {
    const ctx = ctxOf('public', A, { tableId: A.table1.id, publicCode: orderA.code });
    expect(await sqlstate(ctx, (tx) => tx`SELECT 1 FROM restaurant_tables`)).toBe('42501');
    for (const col of ['idempotency_key', 'created_by', 'cancel_reason']) {
      expect({ col, code: await sqlstate(ctx, (tx) => tx.unsafe(`SELECT ${col} FROM orders`)) }).toEqual({ col, code: '42501' });
    }
    expect(await sqlstate(ctx, (tx) => tx`SELECT status, total_cents, table_number FROM orders`)).toBeNull();
  });

  test('a cozinha só pode alterar "disponível" nos pratos, e só o estado nos pedidos', async () => {
    const k = ctxOf('kitchen', A);
    expect(await sqlstate(k, (tx) => tx`UPDATE menu_items SET available = false WHERE id = ${A.menu.sumo.id}`)).toBeNull();
    expect(await sqlstate(k, (tx) => tx`UPDATE menu_items SET price_cents = 1 WHERE id = ${A.menu.sumo.id}`)).toBe('42501');
    expect(await sqlstate(k, (tx) => tx`UPDATE menu_items SET name = 'x' WHERE id = ${A.menu.sumo.id}`)).toBe('42501');
    expect(await sqlstate(k, (tx) => tx`UPDATE orders SET total_cents = 0 WHERE id = ${orderA.id}`)).toBe('42501');
    expect(await sqlstate(k, (tx) => tx`UPDATE orders SET notes = 'x' WHERE id = ${orderA.id}`)).toBe('42501');
    expect(await sqlstate(k, (tx) => tx`DELETE FROM menu_items WHERE id = ${A.menu.sumo.id}`)).toBe('42501');
    expect(await sqlstate(k, (tx) => tx`INSERT INTO categories (restaurant_id, name) VALUES (${A.restaurantId}, 'x')`)).toBe('42501');
    await t.db.system((tx) => tx`UPDATE menu_items SET available = true WHERE id = ${A.menu.sumo.id}`);
  });

  test('empregado não altera o menu, as mesas nem as definições', async () => {
    const w = ctxOf('waiter', A);
    expect(await sqlstate(w, (tx) => tx`UPDATE menu_items SET available = false WHERE id = ${A.menu.sumo.id}`)).toBe('42501');
    expect(await sqlstate(w, (tx) => tx`INSERT INTO restaurant_tables (restaurant_id, table_number, qr_token) VALUES (${A.restaurantId}, 50, ${'w'.repeat(22)})`)).toBe('42501');
    expect(await sqlstate(w, (tx) => tx`UPDATE restaurants SET name = 'x' WHERE id = ${A.restaurantId}`)).toBe('42501');
    expect(await sqlstate(w, (tx) => tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${A.restaurantId}, ${A.userIds.waiter}, 'manager')`)).toBe('42501');
  });

  test('o gerente não altera o domínio dos menus nem lê/escreve utilizadores', async () => {
    const m = ctxOf('manager', A);
    expect(await sqlstate(m, (tx) => tx`UPDATE restaurants SET menu_base_url = 'https://exemplo.pt' WHERE id = ${A.restaurantId}`)).toBe('42501');
    expect(await sqlstate(m, (tx) => tx`UPDATE restaurants SET status = 'suspenso' WHERE id = ${A.restaurantId}`)).toBe('42501');
    expect(await sqlstate(m, (tx) => tx`UPDATE restaurants SET service_fee_bps = 500 WHERE id = ${A.restaurantId}`)).toBeNull();
    expect(await sqlstate(m, (tx) => tx`SELECT email FROM users`)).toBe('42501');
    expect(await sqlstate(m, (tx) => tx`UPDATE users SET active = false`)).toBe('42501');
  });
});

// ---------------------------------------------------------------------------------------------
describe('perfil público (cliente com QR Code)', () => {
  test('só vê o pedido cujo código conhece (ou os da sessão da sua mesa)', async () => {
    const withCode = await t.db.as(ctxOf('public', A, { tableId: A.table1.id, publicCode: orderA.code }), (tx) => tx<{ id: string }>`SELECT id FROM orders`);
    expect(withCode.map((r) => r.id)).toEqual([orderA.id]);
    const noCode = await t.db.as(ctxOf('public', A, { tableId: A.table1.id }), (tx) => tx`SELECT id FROM orders`);
    expect(noCode).toHaveLength(0);
    // com o código do pedido de B mas contexto de A: nada
    const cross = await t.db.as(ctxOf('public', A, { tableId: A.table1.id, publicCode: orderB.code }), (tx) => tx`SELECT id FROM orders`);
    expect(cross).toHaveLength(0);
  });

  test('o cliente não consegue criar pedidos falsificados', async () => {
    const base = { rid: A.restaurantId, tid: A.table1.id };
    const ins = (over: { table?: string; status?: string; source?: string; code?: string; rid?: string }, code = 'c'.repeat(22)) =>
      sqlstate({ role: 'public', restaurantId: A.restaurantId, tableId: A.table1.id, publicCode: code }, (tx) =>
        tx`INSERT INTO orders (restaurant_id, table_id, public_code, status, source, subtotal_cents, service_fee_cents, total_cents)
           VALUES (${over.rid ?? base.rid}, ${over.table ?? base.tid}, ${over.code ?? code}, ${over.status ?? 'novo'}, ${over.source ?? 'qr'}, 0, 0, 0)`);
    expect(await ins({ table: A.table2.id })).toBe('42501'); // outra mesa
    expect(await ins({ status: 'pronto' })).toBe('42501'); // estado falsificado
    expect(await ins({ source: 'staff' })).toBe('42501'); // origem falsificada
    expect(await ins({ code: 'outro-codigo-qualquer-123' })).toBe('42501'); // código diferente do contexto
    expect(await ins({ rid: B.restaurantId, table: B.table1.id })).toBe('42501'); // outro restaurante
  });

  test('itens de um pedido só se inserem na mesma transação que o criou', async () => {
    const code = 'd'.repeat(22);
    const ctx: DbContext = { role: 'public', restaurantId: A.restaurantId, tableId: A.table1.id, publicCode: code };
    let orderId = '';
    await t.db.as(ctx, async (tx) => {
      const [o] = await tx<{ id: string }>`
        INSERT INTO orders (restaurant_id, table_id, public_code, status, source, subtotal_cents, service_fee_cents, total_cents)
        VALUES (${A.restaurantId}, ${A.table1.id}, ${code}, 'novo', 'qr', 0, 0, 0) RETURNING id`;
      orderId = o!.id;
      await tx`INSERT INTO order_items (restaurant_id, order_id, menu_item_id, item_name_snapshot, unit_price_snapshot_cents, quantity, line_total_cents)
               VALUES (${A.restaurantId}, ${orderId}, ${A.menu.sumo.id}, 'Sumo', 0, 1, 0)`;
    });
    // numa transação posterior (mesmo com o código certo) já não é possível acrescentar itens
    const later = await sqlstate(ctx, (tx) =>
      tx`INSERT INTO order_items (restaurant_id, order_id, menu_item_id, item_name_snapshot, unit_price_snapshot_cents, quantity, line_total_cents)
         VALUES (${A.restaurantId}, ${orderId}, ${A.menu.sumo.id}, 'Extra escondido', 0, 1, 0)`);
    expect(later).toBe('42501');
    // nem alterar ou apagar itens existentes
    expect(await sqlstate(ctx, (tx) => tx`UPDATE order_items SET quantity = 99 WHERE order_id = ${orderId}`)).toBe('42501');
    expect(await sqlstate(ctx, (tx) => tx`DELETE FROM order_items WHERE order_id = ${orderId}`)).toBe('42501');
  });

  test('as funções públicas só funcionam para o perfil público e resolvem apenas o necessário', async () => {
    const r = await t.db.as({ role: 'public' }, (tx) => tx<{ table_id: string; restaurant_id: string; table_number: number }>`SELECT * FROM resolve_table_token(${A.table1.token})`);
    expect(r).toHaveLength(1);
    expect(r[0]!.restaurant_id).toBe(A.restaurantId);
    expect((await t.db.as({ role: 'public' }, (tx) => tx`SELECT * FROM resolve_table_token(${'n'.repeat(22)})`))).toHaveLength(0);
    // outros perfis não executam as funções públicas
    expect(await sqlstate(ctxOf('kitchen', A), (tx) => tx`SELECT * FROM resolve_table_token(${A.table1.token})`)).toBe('42501');
    expect(await sqlstate(ctxOf('manager', A), (tx) => tx`SELECT * FROM resolve_order_code(${orderA.code})`)).toBe('42501');
  });
});

// ---------------------------------------------------------------------------------------------
describe('ciclo de vida do pedido (regras na base de dados)', () => {
  test('a regra SQL é idêntica à regra TypeScript para TODAS as combinações perfil × estado × estado', async () => {
    const roles = ['kitchen', 'waiter', 'manager', 'public', 'platform'] as const;
    const mismatches: string[] = [];
    for (const role of roles) {
      for (const from of ORDER_STATUSES) {
        for (const to of ORDER_STATUSES) {
          const sql = await t.db.system(async (tx) => (await tx<{ ok: boolean }>`SELECT order_transition_allowed(${role}, ${from}, ${to}) AS ok`)[0]!.ok);
          const ts = role === 'kitchen' || role === 'waiter' || role === 'manager' ? canTransition(role, from, to) : false;
          if (sql !== ts) mismatches.push(`${role}: ${from} -> ${to} (sql=${sql}, ts=${ts})`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    // o perfil "system" (migrações e manutenção) pode tudo, exceto manter o mesmo estado
    expect(await t.db.system(async (tx) => (await tx<{ ok: boolean }>`SELECT order_transition_allowed('system', 'entregue', 'novo') AS ok`)[0]!.ok)).toBe(true);
    expect(await t.db.system(async (tx) => (await tx<{ ok: boolean }>`SELECT order_transition_allowed('system', 'novo', 'novo') AS ok`)[0]!.ok)).toBe(false);
  });

  test('cada perfil só consegue as transições permitidas ao atualizar diretamente a base de dados', async () => {
    const fresh = async () => {
      const code = 'f'.repeat(10) + Math.random().toString(36).slice(2, 14).padEnd(12, 'x');
      return t.db.system(async (tx) => (await tx<{ id: string }>`
        INSERT INTO orders (restaurant_id, table_id, public_code, subtotal_cents, service_fee_cents, total_cents)
        VALUES (${A.restaurantId}, ${A.table1.id}, ${code}, 0, 0, 0) RETURNING id`)[0]!.id);
    };
    const id = await fresh();
    // cozinha: novo -> entregue é inválido
    expect(await sqlstate(ctxOf('kitchen', A), (tx) => tx`UPDATE orders SET status = 'entregue' WHERE id = ${id}`)).toBe('AL001');
    expect(await sqlstate(ctxOf('kitchen', A), (tx) => tx`UPDATE orders SET status = 'em_preparacao' WHERE id = ${id}`)).toBeNull();
    // empregado: em_preparacao -> pronto é inválido; entregar só depois de pronto
    expect(await sqlstate(ctxOf('waiter', A), (tx) => tx`UPDATE orders SET status = 'pronto' WHERE id = ${id}`)).toBe('AL001');
    expect(await sqlstate(ctxOf('kitchen', A), (tx) => tx`UPDATE orders SET status = 'pronto' WHERE id = ${id}`)).toBeNull();
    expect(await sqlstate(ctxOf('waiter', A), (tx) => tx`UPDATE orders SET status = 'entregue' WHERE id = ${id}`)).toBeNull();
    // entregue é final para todos exceto correções do gerente (com motivo)
    expect(await sqlstate(ctxOf('waiter', A), (tx) => tx`UPDATE orders SET status = 'pronto' WHERE id = ${id}`)).toBe('AL001');
    expect(await sqlstate(ctxOf('manager', A), (tx) => tx`UPDATE orders SET status = 'pronto' WHERE id = ${id}`)).toBe('AL002');
    expect(await sqlstate(ctxOf('manager', A, { reason: 'Entregue por engano' }), (tx) => tx`UPDATE orders SET status = 'pronto' WHERE id = ${id}`)).toBeNull();
    const hist = await t.db.system((tx) => tx<{ previous_status: string | null; new_status: string; changed_by_role: string; reason: string | null }>`
      SELECT previous_status, new_status, changed_by_role, reason FROM order_status_history WHERE order_id = ${id} ORDER BY id`);
    expect(hist.map((h) => `${h.previous_status ?? '∅'}>${h.new_status}`)).toEqual(['∅>novo', 'novo>em_preparacao', 'em_preparacao>pronto', 'pronto>entregue', 'entregue>pronto']);
    expect(hist.at(-1)!.reason).toBe('Entregue por engano');
    expect(hist.at(-1)!.changed_by_role).toBe('manager');
  });

  test('valores, mesa, restaurante e código de um pedido são imutáveis (nem o dono da base os altera)', async () => {
    for (const set of ['total_cents = total_cents + 1, subtotal_cents = subtotal_cents + 1', "public_code = 'x' || public_code", 'table_id = (SELECT id FROM restaurant_tables WHERE restaurant_id = orders.restaurant_id AND table_number = 2)', "source = 'staff'", 'order_number = order_number + 100']) {
      const code = await sqlstateSystem((tx) => tx.unsafe(`UPDATE orders SET ${set} WHERE id = $1`, [orderA.id]));
      expect({ set, code }).toEqual({ set, code: 'AL003' });
    }
  });

  test('o número do pedido é sequencial por dia e restaurante, e acompanha o fuso horário do restaurante', async () => {
    const rid = (await t.db.system(async (tx) => (await tx<{ id: string }>`
      INSERT INTO restaurants (name, slug, timezone) VALUES ('Fuso Teste', 'fuso-teste', 'Pacific/Kiritimati') RETURNING id`)[0]!.id));
    const table = await t.db.system(async (tx) => (await tx<{ id: string }>`
      INSERT INTO restaurant_tables (restaurant_id, table_number, qr_token) VALUES (${rid}, 1, ${'k'.repeat(22)}) RETURNING id`)[0]!.id);
    const rows = await t.db.system(async (tx) => {
      const out: Array<{ order_number: number; order_day: Date; local: string }> = [];
      for (let i = 0; i < 3; i++) {
        const [o] = await tx<{ order_number: number; order_day: Date }>`
          INSERT INTO orders (restaurant_id, table_id, public_code, subtotal_cents, service_fee_cents, total_cents)
          VALUES (${rid}, ${table}, ${'k' + i + 'x'.repeat(21)}, 0, 0, 0) RETURNING order_number, order_day`;
        const [d] = await tx<{ local: string }>`SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS local`;
        out.push({ ...o!, local: d!.local });
      }
      return out;
    });
    expect(rows.map((r) => r.order_number)).toEqual([1, 2, 3]);
    for (const r of rows) expect(new Date(r.order_day).toISOString().slice(0, 10)).toBe(r.local);
  });

  test('fuso horário inexistente é recusado', async () => {
    const code = await sqlstateSystem((tx) => tx`UPDATE restaurants SET timezone = 'Marte/Olympus' WHERE id = ${A.restaurantId}`);
    expect(code).toBe('AL005');
  });
});

// ---------------------------------------------------------------------------------------------
describe('auditoria e pagamentos', () => {
  test('auditoria só se acrescenta: ninguém altera ou apaga, e só se escreve em nome próprio', async () => {
    for (const role of ['kitchen', 'waiter', 'manager'] as const) {
      expect(await sqlstate(ctxOf(role, A), (tx) => tx`UPDATE audit_logs SET action = 'x'`)).toBe('42501');
      expect(await sqlstate(ctxOf(role, A), (tx) => tx`DELETE FROM audit_logs`)).toBe('42501');
      // em nome de outra pessoa → recusado
      expect(await sqlstate(ctxOf(role, A), (tx) => tx`INSERT INTO audit_logs (restaurant_id, actor_id, action) VALUES (${A.restaurantId}, ${B.userIds.manager}, 'falso')`)).toBe('42501');
      // noutro restaurante → recusado
      expect(await sqlstate(ctxOf(role, A), (tx) => tx`INSERT INTO audit_logs (restaurant_id, actor_id, action) VALUES (${B.restaurantId}, ${A.userIds[role]}, 'falso')`)).toBe('42501');
      expect(await sqlstate(ctxOf(role, A), (tx) => tx`INSERT INTO audit_logs (restaurant_id, actor_id, action) VALUES (${A.restaurantId}, ${A.userIds[role]}, 'ok')`)).toBeNull();
    }
    // só o gerente lê a auditoria
    expect(await sqlstate(ctxOf('kitchen', A), (tx) => tx`SELECT 1 FROM audit_logs`)).toBe('42501');
    expect(await sqlstate(ctxOf('waiter', A), (tx) => tx`SELECT 1 FROM audit_logs`)).toBe('42501');
  });

  test('pagamentos: cozinha não vê; empregado regista mas não corrige; gerente corrige', async () => {
    expect(await sqlstate(ctxOf('kitchen', A), (tx) => tx`SELECT 1 FROM payments`)).toBe('42501');
    const w = ctxOf('waiter', A);
    expect(await sqlstate(w, (tx) => tx`INSERT INTO payments (restaurant_id, order_id, method, amount_cents, status, recorded_by) VALUES (${A.restaurantId}, ${orderA.id}, 'terminal', 500, 'pago', ${A.userIds.waiter})`)).toBeNull();
    expect(await sqlstate(w, (tx) => tx`UPDATE payments SET status = 'pago'`)).toBe('42501');
    // registar em nome de outro utilizador → recusado
    expect(await sqlstate(w, (tx) => tx`INSERT INTO payments (restaurant_id, order_id, method, amount_cents, recorded_by) VALUES (${A.restaurantId}, ${orderA.id}, 'dinheiro', 1, ${A.userIds.manager})`)).toBe('42501');
    expect(await sqlstate(ctxOf('manager', A), (tx) => tx`UPDATE payments SET status = 'anulado' WHERE status = 'pendente'`)).toBeNull();
    // pagamento de um pedido de outro restaurante → recusado (chave composta)
    expect(await sqlstate(w, (tx) => tx`INSERT INTO payments (restaurant_id, order_id, method, amount_cents, recorded_by) VALUES (${A.restaurantId}, ${orderB.id}, 'dinheiro', 1, ${A.userIds.waiter})`)).toBe('23503');
  });
});

// ---------------------------------------------------------------------------------------------
describe('verificação automática ao arrancar (selfTest)', () => {
  test('passa com a base de dados correta e falha se o RLS for desligado numa tabela', async () => {
    expect((await t.db.selfTest()).ok).toBe(true);
    await t.db.system((tx) => tx`ALTER TABLE categories DISABLE ROW LEVEL SECURITY`);
    try {
      const r = await t.db.selfTest();
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toContain('categories');
    } finally {
      await t.db.system((tx) => tx`ALTER TABLE categories ENABLE ROW LEVEL SECURITY`);
    }
    expect((await t.db.selfTest()).ok).toBe(true);
  });
});
