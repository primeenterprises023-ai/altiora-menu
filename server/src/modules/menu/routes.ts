// Gestão do menu: o gerente edita categorias, pratos e extras; a cozinha só marca "esgotado/disponível".
import {
  AvailabilityInput,
  CategoryInput,
  CategoryUpdateInput,
  MenuItemInput,
  MenuItemUpdateInput,
  OptionInput,
  OptionUpdateInput,
  uuid,
} from '../../../../shared/schemas';
import type { StaffRole } from '../../../../shared/status';
import type { StaffMenu, StaffMenuCategory, StaffMenuItem, StaffMenuOption } from '../../../../shared/types';
import { num, type Tx } from '../../db/client';
import { updatePartial } from '../../db/dynamic';
import { audit } from '../../lib/audit';
import { purgeOrphanAssets } from '../../lib/assets';
import { conflict, notFound } from '../../lib/errors';
import { requireFeature } from '../../lib/plans';
import { created, json, noContent } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

const staffRoles: ReadonlyArray<StaffRole> = ['manager', 'waiter', 'kitchen'];

function who(ctx: Ctx) {
  const a = ctx.auth!;
  return { role: a.role as StaffRole, restaurantId: a.restaurantId!, userId: a.userId };
}

function notifyMenuChanged(ctx: Ctx, restaurantId: string): void {
  ctx.deps.hub.publishRestaurant(restaurantId, { type: 'menu.changed', at: new Date().toISOString() });
}

function idParam(ctx: Ctx, what: string, code: string): string {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound(`${what} não encontrado.`, code);
  return id.data;
}

// --- leitura --------------------------------------------------------------------------------------
interface CategoryRow { id: string; name: string; display_order: number; active: boolean }
interface ItemRow {
  id: string; category_id: string; name: string; description: string | null; image_url: string | null;
  thumb_url: string | null; model_url: string | null; ingredients: string[]; allergens: string[];
  price_cents: string; available: boolean; active: boolean; display_order: number;
}
interface OptionRow { id: string; menu_item_id: string; name: string; price_delta_cents: string; kind: 'extra' | 'size'; active: boolean; display_order: number }

const CAT_COLS = 'id, name, display_order, active';
const ITEM_COLS = 'id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order';
const OPT_COLS = 'id, menu_item_id, name, price_delta_cents, kind, active, display_order';

const itemView = (r: ItemRow, options: StaffMenuOption[] = []): StaffMenuItem => ({
  id: r.id, category_id: r.category_id, name: r.name, description: r.description, image_url: r.image_url,
  thumb_url: r.thumb_url, model_url: r.model_url, ingredients: r.ingredients, allergens: r.allergens,
  price_cents: num(r.price_cents), available: r.available, active: r.active, display_order: r.display_order, options,
});
const optionView = (r: OptionRow): StaffMenuOption => ({
  id: r.id, name: r.name, price_delta_cents: num(r.price_delta_cents), kind: r.kind, active: r.active, display_order: r.display_order,
});

async function loadMenu(tx: Tx, restaurantId: string): Promise<StaffMenu> {
  const cats = await tx<CategoryRow>`SELECT id, name, display_order, active FROM categories WHERE restaurant_id = ${restaurantId} ORDER BY display_order, lower(name)`;
  const items = await tx<ItemRow>`
    SELECT id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order
    FROM menu_items WHERE restaurant_id = ${restaurantId} ORDER BY display_order, lower(name)`;
  const opts = await tx<OptionRow>`
    SELECT id, menu_item_id, name, price_delta_cents, kind, active, display_order
    FROM menu_item_options WHERE restaurant_id = ${restaurantId} ORDER BY display_order, kind DESC, lower(name)`;
  const optsByItem = new Map<string, StaffMenuOption[]>();
  for (const o of opts) {
    const list = optsByItem.get(o.menu_item_id) ?? [];
    list.push(optionView(o));
    optsByItem.set(o.menu_item_id, list);
  }
  const categories: StaffMenuCategory[] = cats.map((c) => ({
    id: c.id, name: c.name, display_order: c.display_order, active: c.active,
    items: items.filter((i) => i.category_id === c.id).map((i) => itemView(i, optsByItem.get(i.id) ?? [])),
  }));
  return { categories };
}

async function getMenu(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const menu = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, (tx) => loadMenu(tx, a.restaurantId));
  return json(menu);
}

// --- categorias -----------------------------------------------------------------------------------
async function createCategory(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const input = await ctx.body(CategoryInput);
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx<CategoryRow>`
      INSERT INTO categories (restaurant_id, name, display_order, active)
      VALUES (${a.restaurantId}, ${input.name}, ${input.display_order}, ${input.active})
      RETURNING id, name, display_order, active`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.category.create', entityType: 'category', entityId: r!.id, metadata: { name: input.name }, ip: ctx.ip });
    return r!;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return created({ category: { ...row, items: [] } });
}

async function updateCategory(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const id = idParam(ctx, 'Categoria', 'CATEGORY_NOT_FOUND');
  const input = await ctx.body(CategoryUpdateInput);
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const r = await updatePartial<CategoryRow>(tx, 'categories', {
      columns: ['name', 'display_order', 'active'],
      where: 'id = $1 AND restaurant_id = $2',
      whereParams: [id, a.restaurantId],
      returning: CAT_COLS,
    }, input);
    if (!r) throw notFound('Categoria não encontrada.', 'CATEGORY_NOT_FOUND');
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.category.update', entityType: 'category', entityId: id, metadata: { fields: Object.keys(input) }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ category: row });
}

async function deleteCategory(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const id = idParam(ctx, 'Categoria', 'CATEGORY_NOT_FOUND');
  await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [c] = await tx<{ n: number }>`SELECT count(*)::int AS n FROM menu_items WHERE category_id = ${id} AND restaurant_id = ${a.restaurantId}`;
    if ((c?.n ?? 0) > 0) throw conflict('Esta categoria ainda tem pratos. Mova ou apague os pratos primeiro (ou desative a categoria).', 'CATEGORY_NOT_EMPTY');
    const rows = await tx`DELETE FROM categories WHERE id = ${id} AND restaurant_id = ${a.restaurantId} RETURNING id`;
    if (rows.length === 0) throw notFound('Categoria não encontrada.', 'CATEGORY_NOT_FOUND');
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.category.delete', entityType: 'category', entityId: id, ip: ctx.ip });
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return noContent();
}

// --- pratos ---------------------------------------------------------------------------------------
async function createItem(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const input = await ctx.body(MenuItemInput);
  if (input.model_url) await requireFeature(ctx.deps.db, a.restaurantId, 'model_3d', 'pratos em 3D');
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [cat] = await tx`SELECT 1 FROM categories WHERE id = ${input.category_id} AND restaurant_id = ${a.restaurantId}`;
    if (!cat) throw notFound('Categoria não encontrada.', 'CATEGORY_NOT_FOUND');
    const [r] = await tx<ItemRow>`
      INSERT INTO menu_items (restaurant_id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens,
                              price_cents, available, active, display_order)
      VALUES (${a.restaurantId}, ${input.category_id}, ${input.name}, ${input.description}, ${input.image_url}, ${input.thumb_url}, ${input.model_url},
              ${input.ingredients}::text[], ${input.allergens}::text[],
              ${input.price_cents}, ${input.available}, ${input.active}, ${input.display_order})
      RETURNING id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.item.create', entityType: 'menu_item', entityId: r!.id, metadata: { name: input.name, price_cents: input.price_cents }, ip: ctx.ip });
    return r!;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return created({ item: itemView(row) });
}

async function updateItem(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const id = idParam(ctx, 'Prato', 'ITEM_NOT_FOUND');
  const input = await ctx.body(MenuItemUpdateInput);
  if (input.model_url) await requireFeature(ctx.deps.db, a.restaurantId, 'model_3d', 'pratos em 3D');
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    if (input.category_id) {
      const [cat] = await tx`SELECT 1 FROM categories WHERE id = ${input.category_id} AND restaurant_id = ${a.restaurantId}`;
      if (!cat) throw notFound('Categoria não encontrada.', 'CATEGORY_NOT_FOUND');
    }
    const [before] = await tx<{ price_cents: string }>`SELECT price_cents FROM menu_items WHERE id = ${id} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!before) throw notFound('Prato não encontrado.', 'ITEM_NOT_FOUND');
    const r = await updatePartial<ItemRow>(tx, 'menu_items', {
      columns: ['category_id', 'name', 'description', 'image_url', 'thumb_url', 'model_url', 'ingredients', 'allergens', 'price_cents', 'available', 'active', 'display_order'],
      where: 'id = $1 AND restaurant_id = $2',
      whereParams: [id, a.restaurantId],
      returning: ITEM_COLS,
    }, input);
    if (!r) throw notFound('Prato não encontrado.', 'ITEM_NOT_FOUND');
    await purgeOrphanAssets(tx, a.restaurantId);
    const meta: Record<string, unknown> = { fields: Object.keys(input) };
    if (input.price_cents !== undefined && input.price_cents !== num(before.price_cents)) meta.price_change = { from: num(before.price_cents), to: input.price_cents };
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.item.update', entityType: 'menu_item', entityId: id, metadata: meta, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ item: itemView(row) });
}

async function setAvailability(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const id = idParam(ctx, 'Prato', 'ITEM_NOT_FOUND');
  const input = await ctx.body(AvailabilityInput);
  const row = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx<ItemRow>`
      UPDATE menu_items SET available = ${input.available}
      WHERE id = ${id} AND restaurant_id = ${a.restaurantId}
      RETURNING id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order`;
    if (!r) throw notFound('Prato não encontrado.', 'ITEM_NOT_FOUND');
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.item.availability', entityType: 'menu_item', entityId: id, metadata: { available: input.available }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ item: itemView(row) });
}

async function deleteItem(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const id = idParam(ctx, 'Prato', 'ITEM_NOT_FOUND');
  await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const rows = await tx`DELETE FROM menu_items WHERE id = ${id} AND restaurant_id = ${a.restaurantId} RETURNING id`;
    if (rows.length === 0) throw notFound('Prato não encontrado.', 'ITEM_NOT_FOUND');
    await purgeOrphanAssets(tx, a.restaurantId);
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.item.delete', entityType: 'menu_item', entityId: id, ip: ctx.ip });
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return noContent();
}

// --- extras ---------------------------------------------------------------------------------------
async function createOption(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const itemId = idParam(ctx, 'Prato', 'ITEM_NOT_FOUND');
  const input = await ctx.body(OptionInput);
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [item] = await tx`SELECT 1 FROM menu_items WHERE id = ${itemId} AND restaurant_id = ${a.restaurantId}`;
    if (!item) throw notFound('Prato não encontrado.', 'ITEM_NOT_FOUND');
    const [r] = await tx<OptionRow>`
      INSERT INTO menu_item_options (restaurant_id, menu_item_id, name, price_delta_cents, kind, active, display_order)
      VALUES (${a.restaurantId}, ${itemId}, ${input.name}, ${input.price_delta_cents}, ${input.kind}, ${input.active}, ${input.display_order})
      RETURNING id, menu_item_id, name, price_delta_cents, kind, active, display_order`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.option.create', entityType: 'menu_option', entityId: r!.id, metadata: { name: input.name }, ip: ctx.ip });
    return r!;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return created({ option: optionView(row) });
}

async function updateOption(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const id = idParam(ctx, 'Extra', 'OPTION_NOT_FOUND');
  const input = await ctx.body(OptionUpdateInput);
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const r = await updatePartial<OptionRow>(tx, 'menu_item_options', {
      columns: ['name', 'price_delta_cents', 'kind', 'active', 'display_order'],
      where: 'id = $1 AND restaurant_id = $2',
      whereParams: [id, a.restaurantId],
      returning: OPT_COLS,
    }, input);
    if (!r) throw notFound('Extra não encontrado.', 'OPTION_NOT_FOUND');
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.option.update', entityType: 'menu_option', entityId: id, metadata: { fields: Object.keys(input) }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ option: optionView(row) });
}

async function deleteOption(ctx: Ctx): Promise<Response> {
  const a = who(ctx);
  const id = idParam(ctx, 'Extra', 'OPTION_NOT_FOUND');
  await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const rows = await tx`DELETE FROM menu_item_options WHERE id = ${id} AND restaurant_id = ${a.restaurantId} RETURNING id`;
    if (rows.length === 0) throw notFound('Extra não encontrado.', 'OPTION_NOT_FOUND');
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: 'menu.option.delete', entityType: 'menu_option', entityId: id, ip: ctx.ip });
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return noContent();
}

export const menuRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/menu', access: { roles: staffRoles }, handler: getMenu },
  { method: 'POST', path: '/api/menu/categories', access: { roles: ['manager'] }, handler: createCategory },
  { method: 'PATCH', path: '/api/menu/categories/:id', access: { roles: ['manager'] }, handler: updateCategory },
  { method: 'DELETE', path: '/api/menu/categories/:id', access: { roles: ['manager'] }, handler: deleteCategory, noBody: true },
  { method: 'POST', path: '/api/menu/items', access: { roles: ['manager'] }, handler: createItem },
  { method: 'PATCH', path: '/api/menu/items/:id', access: { roles: ['manager'] }, handler: updateItem },
  { method: 'DELETE', path: '/api/menu/items/:id', access: { roles: ['manager'] }, handler: deleteItem, noBody: true },
  { method: 'PATCH', path: '/api/menu/items/:id/availability', access: { roles: ['kitchen', 'manager'] }, handler: setAvailability },
  { method: 'POST', path: '/api/menu/items/:id/options', access: { roles: ['manager'] }, handler: createOption },
  { method: 'PATCH', path: '/api/menu/options/:id', access: { roles: ['manager'] }, handler: updateOption },
  { method: 'DELETE', path: '/api/menu/options/:id', access: { roles: ['manager'] }, handler: deleteOption, noBody: true },
];
