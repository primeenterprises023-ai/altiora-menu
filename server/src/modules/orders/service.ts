// Serviço de pedidos: cálculo de preços NO SERVIDOR, criação, consulta e mudança de estado.
// Nada do que o cliente envia (preços, totais, estados) é usado: só identificadores, quantidades e notas.
import { summarizePayments, type PaymentStatus } from '../../../../shared/payments';
import { randomUUID } from 'node:crypto';
import { iso, num, type Tx } from '../../db/client';
import { conflict, unprocessable } from '../../lib/errors';
import { serviceFeeCents } from '../../../../shared/money';
import type { OrderStatus } from '../../../../shared/status';
import type { CreateOrder } from '../../../../shared/schemas';
import type { OrderItemView, OrderView, PublicOrderView, PublicOrderSummary } from '../../../../shared/types';

export interface OrderLimits {
  maxOrderTotalCents: number;
}

interface PricedOption {
  optionId: string;
  name: string;
  deltaCents: bigint;
  quantity: number;
}

interface PricedLine {
  id: string;
  menuItemId: string;
  name: string;
  basePriceCents: bigint;
  quantity: number;
  notes: string | null;
  lineTotalCents: bigint;
  position: number;
  options: PricedOption[];
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotalCents: bigint;
  serviceFeeCents: bigint;
  totalCents: bigint;
}

/** Valida os itens/extras contra a base de dados e calcula subtotal, taxa e total em cêntimos. */
export async function priceOrder(
  tx: Tx,
  restaurantId: string,
  input: CreateOrder,
  feeBps: number,
  limits: OrderLimits,
): Promise<PricedOrder> {
  const itemIds = [...new Set(input.items.map((i) => i.menu_item_id))];
  const optionIds = [...new Set(input.items.flatMap((i) => i.options.map((o) => o.option_id)))];

  // um prato só pode ser pedido se ele e a sua categoria estiverem ativos
  const items = await tx<{ id: string; name: string; price_cents: string; available: boolean; active: boolean }>`
    SELECT m.id, m.name, m.price_cents, m.available, (m.active AND c.active) AS active
    FROM menu_items m
    JOIN categories c ON c.id = m.category_id AND c.restaurant_id = m.restaurant_id
    WHERE m.restaurant_id = ${restaurantId} AND m.id = ANY(${itemIds}::uuid[])`;
  const itemById = new Map(items.map((r) => [r.id, r]));

  const options = optionIds.length
    ? await tx<{ id: string; menu_item_id: string; name: string; price_delta_cents: string; active: boolean; kind: string }>`
        SELECT id, menu_item_id, name, price_delta_cents, active, kind FROM menu_item_options
        WHERE restaurant_id = ${restaurantId} AND id = ANY(${optionIds}::uuid[])`
    : [];
  const optionById = new Map(options.map((r) => [r.id, r]));
  // pratos com tamanhos: o cliente tem de escolher exatamente um
  const sizeRows = await tx<{ menu_item_id: string }>`
    SELECT DISTINCT menu_item_id FROM menu_item_options
    WHERE restaurant_id = ${restaurantId} AND kind = 'size' AND active AND menu_item_id = ANY(${itemIds}::uuid[])`;
  const itemsWithSizes = new Set(sizeRows.map((r) => r.menu_item_id));

  const unavailable = new Map<string, string>();
  const lines: PricedLine[] = [];
  let subtotal = 0n;

  input.items.forEach((line, index) => {
    const item = itemById.get(line.menu_item_id);
    if (!item || !item.active) {
      throw unprocessable('Um dos itens do pedido já não existe no menu.', 'ITEM_NOT_FOUND', { menu_item_id: line.menu_item_id });
    }
    if (!item.available) unavailable.set(item.id, item.name);

    // junta extras repetidos
    const merged = new Map<string, number>();
    for (const o of line.options) merged.set(o.option_id, (merged.get(o.option_id) ?? 0) + o.quantity);

    const priced: PricedOption[] = [];
    let optionsPerUnit = 0n;
    let sizesChosen = 0;
    for (const [optionId, quantity] of merged) {
      const opt = optionById.get(optionId);
      if (!opt || !opt.active || opt.menu_item_id !== item.id) {
        throw unprocessable('Um dos extras escolhidos já não está disponível.', 'OPTION_NOT_FOUND', { option_id: optionId });
      }
      if (quantity > 10) throw unprocessable('Quantidade de extras demasiado alta.', 'OPTION_QUANTITY');
      if (opt.kind === 'size') {
        sizesChosen += 1;
        if (quantity !== 1) throw unprocessable('Só se pode escolher um tamanho por prato.', 'SIZE_ONE', { menu_item_id: item.id });
      }
      const delta = BigInt(opt.price_delta_cents);
      priced.push({ optionId, name: opt.name, deltaCents: delta, quantity });
      optionsPerUnit += delta * BigInt(quantity);
    }

    if (itemsWithSizes.has(item.id) && sizesChosen !== 1) {
      throw unprocessable(`Escolha o tamanho de ${item.name}.`, 'SIZE_REQUIRED', { menu_item_id: item.id });
    }
    if (!itemsWithSizes.has(item.id) && sizesChosen > 0) {
      throw unprocessable('Um dos tamanhos escolhidos já não está disponível.', 'OPTION_NOT_FOUND', { menu_item_id: item.id });
    }

    const base = BigInt(item.price_cents);
    const lineTotal = (base + optionsPerUnit) * BigInt(line.quantity);
    subtotal += lineTotal;
    if (subtotal > BigInt(limits.maxOrderTotalCents)) {
      throw unprocessable('O valor do pedido excede o limite permitido.', 'ORDER_TOO_LARGE');
    }
    lines.push({
      id: randomUUID(),
      menuItemId: item.id,
      name: item.name,
      basePriceCents: base,
      quantity: line.quantity,
      notes: line.notes,
      lineTotalCents: lineTotal,
      position: index,
      options: priced,
    });
  });

  if (unavailable.size > 0) {
    throw conflict('Alguns itens esgotaram entretanto. Remova-os do pedido para continuar.', 'ITEM_UNAVAILABLE', {
      items: [...unavailable].map(([id, name]) => ({ id, name })),
    });
  }

  const fee = serviceFeeCents(subtotal, feeBps);
  return { lines, subtotalCents: subtotal, serviceFeeCents: fee, totalCents: subtotal + fee };
}

export interface InsertOrderParams {
  restaurantId: string;
  tableId: string;
  tableSessionId: string | null;
  publicCode: string;
  source: 'qr' | 'staff';
  createdBy: string | null;
  priced: PricedOrder;
  notes: string | null;
  idempotencyKey: string | null;
}

/** Grava o pedido, os itens e os extras (copiando nomes e preços do momento) dentro da transação atual. */
export async function insertOrder(tx: Tx, p: InsertOrderParams): Promise<{ id: string }> {
  const money = [p.priced.subtotalCents.toString(), p.priced.serviceFeeCents.toString(), p.priced.totalCents.toString()];
  let rows: Array<{ id: string }>;
  if (p.source === 'qr') {
    // o perfil público não pode indicar "created_by"
    rows = await tx<{ id: string }>`
      INSERT INTO orders (restaurant_id, table_id, table_session_id, public_code, status, source,
                          subtotal_cents, service_fee_cents, total_cents, notes, idempotency_key)
      VALUES (${p.restaurantId}, ${p.tableId}, ${p.tableSessionId}, ${p.publicCode}, 'novo', 'qr',
              ${money[0]}, ${money[1]}, ${money[2]}, ${p.notes}, ${p.idempotencyKey})
      RETURNING id`;
  } else {
    rows = await tx<{ id: string }>`
      INSERT INTO orders (restaurant_id, table_id, table_session_id, public_code, status, source, created_by,
                          subtotal_cents, service_fee_cents, total_cents, notes, idempotency_key)
      VALUES (${p.restaurantId}, ${p.tableId}, ${p.tableSessionId}, ${p.publicCode}, 'novo', 'staff', ${p.createdBy},
              ${money[0]}, ${money[1]}, ${money[2]}, ${p.notes}, ${p.idempotencyKey})
      RETURNING id`;
  }
  const orderId = rows[0]!.id;

  const itemsJson = JSON.stringify(
    p.priced.lines.map((l) => ({
      id: l.id,
      menu_item_id: l.menuItemId,
      name: l.name,
      price: Number(l.basePriceCents),
      qty: l.quantity,
      notes: l.notes,
      total: Number(l.lineTotalCents),
      pos: l.position,
    })),
  );
  await tx.unsafe(
    `INSERT INTO order_items (id, restaurant_id, order_id, menu_item_id, item_name_snapshot, unit_price_snapshot_cents,
                              quantity, notes, line_total_cents, position)
     SELECT x.id, $1::uuid, $2::uuid, x.menu_item_id, x.name, x.price, x.qty, x.notes, x.total, x.pos
     FROM jsonb_to_recordset($3::text::jsonb)
       AS x(id uuid, menu_item_id uuid, name text, price bigint, qty int, notes text, total bigint, pos int)`,
    [p.restaurantId, orderId, itemsJson],
  );

  const optionRows = p.priced.lines.flatMap((l) =>
    l.options.map((o) => ({ order_item_id: l.id, option_id: o.optionId, name: o.name, delta: Number(o.deltaCents), qty: o.quantity })),
  );
  if (optionRows.length > 0) {
    await tx.unsafe(
      `INSERT INTO order_item_options (restaurant_id, order_item_id, option_id, option_name_snapshot, price_delta_snapshot_cents, quantity)
       SELECT $1::uuid, x.order_item_id, x.option_id, x.name, x.delta, x.qty
       FROM jsonb_to_recordset($2::text::jsonb) AS x(order_item_id uuid, option_id uuid, name text, delta bigint, qty int)`,
      [p.restaurantId, JSON.stringify(optionRows)],
    );
  }
  return { id: orderId };
}

// ---------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------

interface ItemRow {
  id: string;
  order_id: string;
  name: string;
  unit_price_snapshot_cents: string;
  quantity: number;
  notes: string | null;
  line_total_cents: string;
}
interface OptionRow {
  order_item_id: string;
  name: string;
  price_delta_snapshot_cents: string;
  quantity: number;
}

async function loadItems(tx: Tx, orderIds: string[]): Promise<Map<string, OrderItemView[]>> {
  const byOrder = new Map<string, OrderItemView[]>();
  if (orderIds.length === 0) return byOrder;
  const items = await tx<ItemRow>`
    SELECT i.id, i.order_id, i.item_name_snapshot AS name, i.unit_price_snapshot_cents, i.quantity, i.notes, i.line_total_cents
    FROM order_items i WHERE i.order_id = ANY(${orderIds}::uuid[]) ORDER BY i.position, i.id`;
  const itemIds = items.map((i) => i.id);
  const options = itemIds.length
    ? await tx<OptionRow>`
        SELECT o.order_item_id, o.option_name_snapshot AS name, o.price_delta_snapshot_cents, o.quantity
        FROM order_item_options o WHERE o.order_item_id = ANY(${itemIds}::uuid[]) ORDER BY o.option_name_snapshot`
    : [];
  const optsByItem = new Map<string, OrderItemView['options']>();
  for (const o of options) {
    const list = optsByItem.get(o.order_item_id) ?? [];
    list.push({ name: o.name, quantity: o.quantity, price_delta_cents: num(o.price_delta_snapshot_cents) });
    optsByItem.set(o.order_item_id, list);
  }
  for (const i of items) {
    const list = byOrder.get(i.order_id) ?? [];
    list.push({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unit_price_cents: num(i.unit_price_snapshot_cents),
      line_total_cents: num(i.line_total_cents),
      notes: i.notes,
      options: optsByItem.get(i.id) ?? [],
    });
    byOrder.set(i.order_id, list);
  }
  return byOrder;
}

const STAFF_COLUMNS = `o.id, o.order_number, o.order_day, o.table_id, o.table_number, o.table_label, o.status, o.source,
  o.subtotal_cents, o.service_fee_cents, o.total_cents, o.notes, o.created_at, o.updated_at,
  o.preparing_at, o.ready_at, o.delivered_at, o.cancelled_at, o.cancel_reason`;

interface StaffRow {
  id: string;
  order_number: number;
  order_day: Date | string;
  table_id: string;
  table_number: number;
  table_label: string | null;
  status: OrderStatus;
  source: 'qr' | 'staff';
  subtotal_cents: string;
  service_fee_cents: string;
  total_cents: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  preparing_at: Date | null;
  ready_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

function dayString(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export interface ListFilter {
  statuses?: OrderStatus[];
  since?: Date;
  before?: Date;
  tableId?: string;
  /** Só pedidos não cancelados com valor por receber (nem isentos nem totalmente pagos). Só para gerente e empregado. */
  unpaid?: boolean;
  limit: number;
  direction: 'asc' | 'desc';
}

export async function listOrders(tx: Tx, restaurantId: string, f: ListFilter): Promise<OrderView[]> {
  const params: unknown[] = [restaurantId];
  const where = ['o.restaurant_id = $1'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.statuses?.length) add('o.status = ANY(?::text[])', f.statuses);
  if (f.since) add('o.created_at >= ?::timestamptz', f.since.toISOString());
  if (f.before) add('o.created_at < ?::timestamptz', f.before.toISOString());
  if (f.tableId) add('o.table_id = ?::uuid', f.tableId);
  if (f.unpaid) {
    where.push("o.status <> 'cancelado'");
    where.push("NOT EXISTS (SELECT 1 FROM payments x WHERE x.order_id = o.id AND x.status = 'isento')");
    where.push("o.total_cents > coalesce((SELECT sum(x.amount_cents) FROM payments x WHERE x.order_id = o.id AND x.status = 'pago'), 0)");
  }
  params.push(f.limit);
  const sql = `SELECT ${STAFF_COLUMNS} FROM orders o WHERE ${where.join(' AND ')}
               ORDER BY o.created_at ${f.direction === 'asc' ? 'ASC' : 'DESC'}, o.order_number ${f.direction === 'asc' ? 'ASC' : 'DESC'}
               LIMIT $${params.length}`;
  const rows = await tx.unsafe<StaffRow>(sql, params);
  const items = await loadItems(tx, rows.map((r) => r.id));
  const views = rows.map((r) => toStaffView(r, items.get(r.id) ?? []));
  await attachPayments(tx, views);
  return views;
}

/** Junta o resumo de pagamentos a cada pedido. A cozinha não vê pagamentos (a base de dados nem lho permite). */
async function attachPayments(tx: Tx, orders: OrderView[]): Promise<void> {
  if (orders.length === 0 || (tx.role !== 'manager' && tx.role !== 'waiter')) return;
  const rows = await tx<{ order_id: string; status: PaymentStatus; amount_cents: string }>`
    SELECT order_id, status, amount_cents FROM payments WHERE order_id = ANY(${orders.map((o) => o.id)}::uuid[])`;
  const byOrder = new Map<string, Array<{ status: PaymentStatus; amount_cents: number }>>();
  for (const p of rows) {
    const list = byOrder.get(p.order_id) ?? [];
    list.push({ status: p.status, amount_cents: num(p.amount_cents) });
    byOrder.set(p.order_id, list);
  }
  for (const o of orders) o.payment = summarizePayments(o.total_cents, byOrder.get(o.id) ?? []);
}

export async function getOrder(tx: Tx, restaurantId: string, orderId: string): Promise<OrderView | null> {
  const rows = await tx.unsafe<StaffRow>(`SELECT ${STAFF_COLUMNS} FROM orders o WHERE o.restaurant_id = $1 AND o.id = $2`, [restaurantId, orderId]);
  if (!rows[0]) return null;
  const items = await loadItems(tx, [orderId]);
  const view = toStaffView(rows[0], items.get(orderId) ?? []);
  await attachPayments(tx, [view]);
  return view;
}

function toStaffView(r: StaffRow, items: OrderItemView[]): OrderView {
  return {
    id: r.id,
    order_number: r.order_number,
    order_day: dayString(r.order_day),
    table_id: r.table_id,
    table_number: r.table_number,
    table_label: r.table_label,
    status: r.status,
    source: r.source,
    subtotal_cents: num(r.subtotal_cents),
    service_fee_cents: num(r.service_fee_cents),
    total_cents: num(r.total_cents),
    notes: r.notes,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    preparing_at: iso(r.preparing_at),
    ready_at: iso(r.ready_at),
    delivered_at: iso(r.delivered_at),
    cancelled_at: iso(r.cancelled_at),
    payment: null,
    cancel_reason: r.cancel_reason,
    items,
  };
}

interface PublicRow {
  id: string;
  order_number: number;
  public_code: string;
  status: OrderStatus;
  table_number: number;
  table_label: string | null;
  restaurant_name: string;
  accent_color: string | null;
  subtotal_cents: string;
  service_fee_cents: string;
  total_cents: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  preparing_at: Date | null;
  ready_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
}

/** Vista pública de um pedido, a partir do código (o contexto já tem restaurante e código definidos). */
export async function loadPublicOrder(tx: Tx, restaurantId: string, publicCode: string): Promise<PublicOrderView | null> {
  const rows = await tx<PublicRow>`
    SELECT o.id, o.order_number, o.public_code, o.status, o.table_number, o.table_label, r.name AS restaurant_name, r.accent_color,
           o.subtotal_cents, o.service_fee_cents, o.total_cents, o.notes, o.created_at, o.updated_at,
           o.preparing_at, o.ready_at, o.delivered_at, o.cancelled_at
    FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
    WHERE o.restaurant_id = ${restaurantId} AND o.public_code = ${publicCode}`;
  const r = rows[0];
  if (!r) return null;
  const items = await loadItems(tx, [r.id]);
  return {
    order_number: r.order_number,
    public_code: r.public_code,
    status: r.status,
    table_number: r.table_number,
    table_label: r.table_label,
    restaurant_name: r.restaurant_name,
    accent_color: r.accent_color,
    subtotal_cents: num(r.subtotal_cents),
    service_fee_cents: num(r.service_fee_cents),
    total_cents: num(r.total_cents),
    notes: r.notes,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    preparing_at: iso(r.preparing_at),
    ready_at: iso(r.ready_at),
    delivered_at: iso(r.delivered_at),
    cancelled_at: iso(r.cancelled_at),
    items: items.get(r.id) ?? [],
  };
}

/** Pedidos da sessão atual da mesa (o contexto já tem a sessão definida). */
export async function listSessionOrders(tx: Tx, restaurantId: string): Promise<PublicOrderSummary[]> {
  const rows = await tx<{ order_number: number; public_code: string; status: OrderStatus; total_cents: string; created_at: Date }>`
    SELECT order_number, public_code, status, total_cents, created_at FROM orders
    WHERE restaurant_id = ${restaurantId} ORDER BY created_at DESC LIMIT 30`;
  return rows.map((r) => ({
    order_number: r.order_number,
    public_code: r.public_code,
    status: r.status,
    total_cents: num(r.total_cents),
    created_at: iso(r.created_at)!,
  }));
}
