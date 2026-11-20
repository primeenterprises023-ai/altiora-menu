import { describe, expect, test } from 'bun:test';
import {
  AdminCreateRestaurantInput,
  AdminUpdateRestaurantInput,
  AvailabilityInput,
  CategoryInput,
  CategoryUpdateInput,
  CreateOrderInput,
  LoginInput,
  MenuItemInput,
  MenuItemUpdateInput,
  OptionInput,
  OrderStatusInput,
  RestaurantUpdateInput,
  StaffCreateOrderInput,
  TableCreateInput,
  TableUpdateInput,
  slug,
} from './schemas';

const U1 = '3f2b6b1e-8c2a-4b0e-9d57-1a2b3c4d5e6f';
const U2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;
const out = <T>(schema: { parse: (v: unknown) => T }, v: unknown) => schema.parse(v);
const line = (extra: Record<string, unknown> = {}) => ({ menu_item_id: U1, quantity: 1, ...extra });

describe('autenticação', () => {
  test('o e-mail é limpo e posto em minúsculas; campos a mais são recusados', () => {
    expect(out(LoginInput, { email: '  Maria@Terraza.AO ', password: 'x' })).toEqual({ email: 'maria@terraza.ao', password: 'x' });
    expect(ok(LoginInput, { email: 'sem-arroba', password: 'x' })).toBe(false);
    expect(ok(LoginInput, { email: 'a@b.pt', password: '' })).toBe(false);
    expect(ok(LoginInput, { email: 'a@b.pt', password: 'x'.repeat(201) })).toBe(false);
    expect(ok(LoginInput, { email: 'a@b.pt', password: 'x', is_platform_admin: true })).toBe(false);
    expect(ok(LoginInput, { email: ['a@b.pt'], password: 'x' })).toBe(false);
  });
});

describe('pedido do cliente: nunca leva preços', () => {
  test('o formato mínimo é aceite e recebe valores por omissão', () => {
    const parsed = out(CreateOrderInput, { items: [line()] });
    expect(parsed).toEqual({ items: [{ menu_item_id: U1, quantity: 1, notes: null, options: [] }], notes: null });
  });

  test('qualquer tentativa de enviar preços ou totais é recusada', () => {
    for (const forbidden of [{ price_cents: 1 }, { unit_price_cents: 1 }, { total_cents: 1 }, { price: 1 }, { name: 'Prato grátis' }]) {
      expect({ forbidden, ok: ok(CreateOrderInput, { items: [line(forbidden)] }) }).toEqual({ forbidden, ok: false });
      expect({ forbidden, ok: ok(CreateOrderInput, { items: [line()], ...forbidden }) }).toEqual({ forbidden, ok: false });
    }
    expect(ok(CreateOrderInput, { items: [line({ options: [{ option_id: U2, price_delta_cents: 0 }] })] })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line()], restaurant_id: U2 })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line()], status: 'entregue' })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line()], table_id: U2 })).toBe(false); // a mesa vem do QR Code, nunca do corpo
  });

  test('quantidades, número de linhas e total de unidades têm limites', () => {
    for (const q of [0, -1, 21, 1.5, '2', null, NaN, Infinity]) expect({ q, ok: ok(CreateOrderInput, { items: [line({ quantity: q })] }) }).toEqual({ q, ok: false });
    for (const q of [1, 2, 20]) expect(ok(CreateOrderInput, { items: [line({ quantity: q })] })).toBe(true);
    expect(ok(CreateOrderInput, { items: [] })).toBe(false);
    expect(ok(CreateOrderInput, {})).toBe(false);
    expect(ok(CreateOrderInput, { items: Array.from({ length: 40 }, () => line()) })).toBe(true);
    expect(ok(CreateOrderInput, { items: Array.from({ length: 41 }, () => line()) })).toBe(false);
    // 6 × 20 = 120 unidades > 100
    expect(ok(CreateOrderInput, { items: Array.from({ length: 6 }, () => line({ quantity: 20 })) })).toBe(false);
    expect(ok(CreateOrderInput, { items: Array.from({ length: 5 }, () => line({ quantity: 20 })) })).toBe(true);
  });

  test('extras: quantidade por omissão 1, máximo 10 por extra e 15 extras por prato', () => {
    const parsed = out(CreateOrderInput, { items: [line({ options: [{ option_id: U2 }] })] });
    expect(parsed.items[0]!.options).toEqual([{ option_id: U2, quantity: 1 }]);
    expect(ok(CreateOrderInput, { items: [line({ options: [{ option_id: U2, quantity: 10 }] })] })).toBe(true);
    expect(ok(CreateOrderInput, { items: [line({ options: [{ option_id: U2, quantity: 11 }] })] })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line({ options: [{ option_id: U2, quantity: 0 }] })] })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line({ options: Array.from({ length: 15 }, () => ({ option_id: U2 })) })] })).toBe(true);
    expect(ok(CreateOrderInput, { items: [line({ options: Array.from({ length: 16 }, () => ({ option_id: U2 })) })] })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line({ options: [{ option_id: 'x' }] })] })).toBe(false);
  });

  test('identificadores têm de ser UUID; notas são limpas e limitadas; o caráter nulo não passa', () => {
    for (const id of ['', 'abc', '123', U1.toUpperCase().replace(/-/g, ''), `${U1}x`, "'; DROP TABLE orders; --", 42, null]) {
      expect({ id, ok: ok(CreateOrderInput, { items: [line({ menu_item_id: id })] }) }).toEqual({ id, ok: false });
    }
    expect(out(CreateOrderInput, { items: [line({ notes: '  sem cebola  ' })], notes: '   ' })).toMatchObject({ items: [{ notes: 'sem cebola' }], notes: null });
    expect(ok(CreateOrderInput, { items: [line({ notes: 'x'.repeat(300) })] })).toBe(true);
    expect(ok(CreateOrderInput, { items: [line({ notes: 'x'.repeat(301) })] })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line()], notes: 'x'.repeat(501) })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line({ notes: 'a\u0000b' })] })).toBe(false);
    expect(ok(CreateOrderInput, { items: [line()], notes: 'a\u0000b' })).toBe(false);
    // texto "estranho" mas válido é preservado sem alterações
    const nasty = '<img src=x onerror=alert(1)> \' " ; -- 🍗 {{7*7}}';
    expect(out(CreateOrderInput, { items: [line({ notes: nasty })] }).items[0]!.notes).toBe(nasty);
  });

  test('o pedido manual do empregado exige a mesa e tem as mesmas regras', () => {
    expect(ok(StaffCreateOrderInput, { table_id: U2, items: [line()] })).toBe(true);
    expect(ok(StaffCreateOrderInput, { items: [line()] })).toBe(false);
    expect(ok(StaffCreateOrderInput, { table_id: U2, items: [line({ price_cents: 1 })] })).toBe(false);
  });
});

describe('alteração de estado', () => {
  test('estados válidos; motivo com 3 a 300 caracteres', () => {
    expect(ok(OrderStatusInput, { to: 'pronto' })).toBe(true);
    expect(ok(OrderStatusInput, { to: 'pronto', from: 'em_preparacao' })).toBe(true);
    for (const to of ['pago', 'ENTREGUE', '', null, 1]) expect({ to, ok: ok(OrderStatusInput, { to }) }).toEqual({ to, ok: false });
    expect(ok(OrderStatusInput, { to: 'cancelado', reason: 'ab' })).toBe(false);
    expect(ok(OrderStatusInput, { to: 'cancelado', reason: '  cliente desistiu ' })).toBe(true);
    expect(out(OrderStatusInput, { to: 'cancelado', reason: '  cliente desistiu ' }).reason).toBe('cliente desistiu');
    expect(ok(OrderStatusInput, { to: 'cancelado', reason: 'x'.repeat(301) })).toBe(false);
    expect(ok(OrderStatusInput, { to: 'cancelado', reason: 'a\u0000bc' })).toBe(false);
    expect(ok(OrderStatusInput, { to: 'pronto', payment_status: 'pago' })).toBe(false);
  });
});

describe('mesas', () => {
  test('número de 1 a 9999; legenda opcional; alterações precisam de pelo menos um campo', () => {
    for (const n of [1, 9999]) expect(ok(TableCreateInput, { table_number: n })).toBe(true);
    for (const n of [0, -1, 10000, 1.5, '7', null, undefined]) expect({ n, ok: ok(TableCreateInput, { table_number: n }) }).toEqual({ n, ok: false });
    expect(out(TableCreateInput, { table_number: 3, label: '  ' })).toEqual({ table_number: 3, label: null });
    expect(ok(TableCreateInput, { table_number: 3, label: 'x'.repeat(61) })).toBe(false);
    expect(ok(TableCreateInput, { table_number: 3, qr_token: 'abc' })).toBe(false);
    expect(ok(TableUpdateInput, {})).toBe(false);
    expect(ok(TableUpdateInput, { active: false })).toBe(true);
    expect(ok(TableUpdateInput, { table_number: 4 })).toBe(false);
  });
});

describe('menu', () => {
  const item = (extra: Record<string, unknown> = {}) => ({ category_id: U1, name: 'Muamba', price_cents: 450000, ...extra });

  test('preço: inteiro em cêntimos, de 0 a 100 000 000 000', () => {
    for (const p of [0, 1, 450000, 100_000_000_000]) expect({ p, ok: ok(MenuItemInput, item({ price_cents: p })) }).toEqual({ p, ok: true });
    for (const p of [-1, 100_000_000_001, 1.5, '450000', null, NaN, Infinity, 1e21]) expect({ p, ok: ok(MenuItemInput, item({ price_cents: p })) }).toEqual({ p, ok: false });
    expect(ok(MenuItemInput, { category_id: U1, name: 'Sem preço' })).toBe(false);
  });

  test('valores por omissão, textos limpos e campos desconhecidos recusados', () => {
    expect(out(MenuItemInput, item({ name: '  Muamba  ', description: '' }))).toEqual({
      category_id: U1, name: 'Muamba', description: null, image_url: null, thumb_url: null, model_url: null, ingredients: [], allergens: [], price_cents: 450000, available: true, active: true, display_order: 0,
    });
    expect(ok(MenuItemInput, item({ name: '   ' }))).toBe(false);
    expect(ok(MenuItemInput, item({ name: 'x'.repeat(121) }))).toBe(false);
    expect(ok(MenuItemInput, item({ restaurant_id: U2 }))).toBe(false);
    expect(ok(MenuItemInput, item({ id: U2 }))).toBe(false);
    expect(ok(MenuItemInput, item({ name: 'a\u0000b' }))).toBe(false);
  });

  test('endereços de imagem: só https:// ou um caminho do próprio site', () => {
    for (const url of ['https://exemplo.ao/a.jpg', '/imagens/prato.jpg', 'https://exemplo.ao/a.jpg?x=1&y=2']) expect({ url, ok: ok(MenuItemInput, item({ image_url: url })) }).toEqual({ url, ok: true });
    for (const url of ['http://exemplo.ao/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//outro.site/a.jpg', 'ftp://x/y', 'https://', 'https://a b.pt', '/a b', 'file:///etc/passwd', 'https://x.pt/\u0000', 'prato.jpg']) {
      expect({ url, ok: ok(MenuItemInput, item({ image_url: url })) }).toEqual({ url, ok: false });
    }
    expect(out(MenuItemInput, item({ image_url: '' })).image_url).toBeNull();
    expect(out(MenuItemInput, item({ image_url: null })).image_url).toBeNull();
  });

  test('atualizações parciais: pelo menos um campo e só os conhecidos', () => {
    expect(ok(MenuItemUpdateInput, {})).toBe(false);
    expect(ok(MenuItemUpdateInput, { price_cents: 100 })).toBe(true);
    expect(ok(MenuItemUpdateInput, { price_cents: -1 })).toBe(false);
    expect(ok(MenuItemUpdateInput, { restaurant_id: U2 })).toBe(false);
    expect(ok(CategoryUpdateInput, {})).toBe(false);
    expect(ok(CategoryUpdateInput, { active: false })).toBe(true);
    expect(ok(AvailabilityInput, { available: false })).toBe(true);
    expect(ok(AvailabilityInput, { available: 'false' })).toBe(false);
    expect(ok(AvailabilityInput, { available: false, price_cents: 0 })).toBe(false);
  });

  test('categorias e extras', () => {
    expect(out(CategoryInput, { name: ' Bebidas ' })).toEqual({ name: 'Bebidas', display_order: 0, active: true });
    expect(ok(CategoryInput, { name: '' })).toBe(false);
    expect(ok(CategoryInput, { name: 'x'.repeat(81) })).toBe(false);
    expect(out(OptionInput, { name: 'Ovo' })).toEqual({ name: 'Ovo', kind: 'extra', price_delta_cents: 0, active: true, display_order: 0 });
    expect(ok(OptionInput, { name: 'Ovo', price_delta_cents: -10 })).toBe(false);
  });
});

describe('restaurante e plataforma', () => {
  test('definições: taxa de serviço 0–30 %, cor #RRGGBB, nome mínimo 2 letras', () => {
    expect(ok(RestaurantUpdateInput, {})).toBe(false);
    for (const bps of [0, 1000, 1250, 3000]) expect({ bps, ok: ok(RestaurantUpdateInput, { service_fee_bps: bps }) }).toEqual({ bps, ok: true });
    for (const bps of [-1, 3001, 10.5, '1000', null]) expect({ bps, ok: ok(RestaurantUpdateInput, { service_fee_bps: bps }) }).toEqual({ bps, ok: false });
    expect(ok(RestaurantUpdateInput, { accent_color: '#B4541F' })).toBe(true);
    for (const c of ['B4541F', '#B4541', '#B4541FF', 'vermelho', 'rgb(1,2,3)', '#GGGGGG']) expect({ c, ok: ok(RestaurantUpdateInput, { accent_color: c }) }).toEqual({ c, ok: false });
    expect(out(RestaurantUpdateInput, { accent_color: '' }).accent_color).toBeNull();
    expect(ok(RestaurantUpdateInput, { name: 'X' })).toBe(false);
    expect(ok(RestaurantUpdateInput, { accepting_orders: false })).toBe(true);
    // só a plataforma altera estes
    for (const k of ['status', 'slug', 'menu_base_url', 'id', 'currency']) expect({ k, ok: ok(RestaurantUpdateInput, { name: 'Valido', [k]: 'x' }) }).toEqual({ k, ok: false });
  });

  test('criação de restaurante pela plataforma e endereço (slug)', () => {
    expect(out(AdminCreateRestaurantInput, { name: 'Terraço', manager: { name: 'Maria', email: ' MARIA@x.ao ' } })).toEqual({
      name: 'Terraço', manager: { name: 'Maria', email: 'maria@x.ao' },
    });
    expect(ok(AdminCreateRestaurantInput, { name: 'T', manager: { name: 'Maria', email: 'maria@x.ao' } })).toBe(false);
    expect(ok(AdminCreateRestaurantInput, { name: 'Terraço', manager: { name: 'Maria', email: 'maria' } })).toBe(false);
    expect(ok(AdminCreateRestaurantInput, { name: 'Terraço', manager: { name: 'Maria', email: 'maria@x.ao', role: 'platform' } })).toBe(false);
    for (const s of ['ab', 'terraza-talatona', 'a1-b2-c3']) expect({ s, ok: ok(slug, s) }).toEqual({ s, ok: true });
    for (const s of ['a', '-ab', 'ab-', 'a--b', 'A B', 'ação', 'a_b', 'x'.repeat(61), '../etc']) expect({ s, ok: ok(slug, s) }).toEqual({ s, ok: false });
    expect(out(slug, ' Terraza ')).toBe('terraza');
    expect(ok(AdminUpdateRestaurantInput, { status: 'suspenso' })).toBe(true);
    expect(ok(AdminUpdateRestaurantInput, { status: 'apagado' })).toBe(false);
    expect(ok(AdminUpdateRestaurantInput, {})).toBe(false);
  });
});
