import { describe, expect, test } from 'bun:test';
import { serviceFeeCents } from '../../../shared/money';
import type { MenuItem, PublicMenu } from '../../../shared/types';
import { cartAvailable, cartSubtotal, cartUnits, feeFor, feeLabel, lineKey, lineTotal, reconcileCart, toPayload, type CartLine } from './cart';

const item = (over: Partial<MenuItem> & { id: string }): MenuItem => ({
  name: 'Prato',
  description: null,
  image_url: null,
  thumb_url: null,
  model_url: null,
  ingredients: [],
  allergens: [],
  price_cents: 100_000,
  available: true,
  options: [],
  ...over,
});

const menuOf = (...items: MenuItem[]): PublicMenu => ({
  restaurant: {
    slug: 'r', name: 'R', description: null, logo_url: null, cover_url: null, accent_color: null, service_fee_bps: 1000, address: null, phone: null, email: null, whatsapp: null,
    maps_url: null, opening_hours: {}, timezone: 'Africa/Luanda', currency: 'AOA', theme: 'dark', font: 'serif', is_demo: false, show_brand: true,
  },
  table: { number: 1, label: null },
  accepting_orders: true,
  capabilities: { orders: true, whatsapp: false, model_3d: false, ar: false, waiter_call: true },
  waiter_call: null,
  categories: [{ id: 'c1', name: 'Tudo', items }],
});

const line = (over: Partial<CartLine> & { itemId: string }): CartLine => ({
  key: lineKey(over.itemId, (over.options ?? []).map((o) => o.id), over.notes ?? ''),
  name: 'Prato',
  unitCents: 100_000,
  quantity: 1,
  notes: '',
  options: [],
  ...over,
});

describe('taxa de serviço no ecrã', () => {
  test('dá sempre o mesmo resultado que a regra do servidor', () => {
    const bpsValues = [0, 1, 250, 500, 1000, 1250, 1500, 10000];
    let state = 12345;
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
    for (const bps of bpsValues) {
      for (let i = 0; i < 400; i++) {
        const subtotal = next() % 50_000_000; // até 500 000 Kz
        expect(feeFor(subtotal, bps)).toBe(Number(serviceFeeCents(BigInt(subtotal), bps)));
      }
      for (const edge of [0, 1, 4, 5, 6, 49, 50, 51, 99, 100, 101, 999_999_999]) {
        expect(feeFor(edge, bps)).toBe(Number(serviceFeeCents(BigInt(edge), bps)));
      }
    }
  });

  test('arredonda ao cêntimo, meio para cima', () => {
    expect(feeFor(5, 1000)).toBe(1); // 0,5 → 1
    expect(feeFor(4, 1000)).toBe(0); // 0,4 → 0
    expect(feeFor(1_000_000, 1000)).toBe(100_000);
    expect(feeFor(0, 1000)).toBe(0);
  });

  test('valores enormes continuam certos (sem perder precisão)', () => {
    const huge = 9_000_000_000_000_000; // acima do limite seguro quando multiplicado
    expect(feeFor(huge, 1000)).toBe(Number(serviceFeeCents(BigInt(huge), 1000)));
  });

  test('etiqueta da taxa', () => {
    expect(feeLabel(1000)).toBe('10 %');
    expect(feeLabel(1250)).toBe('12,5 %');
  });
});

describe('linhas do pedido', () => {
  test('a mesma escolha dá sempre a mesma linha (extras em qualquer ordem, nota sem diferenças de maiúsculas/espaços)', () => {
    expect(lineKey('a', ['x', 'y'], 'Sem sal')).toBe(lineKey('a', ['y', 'x'], '  sem sal '));
    expect(lineKey('a', ['x'], '')).not.toBe(lineKey('a', [], ''));
    expect(lineKey('a', [], 'sem sal')).not.toBe(lineKey('b', [], 'sem sal'));
    expect(lineKey('a', [], 'sem sal')).not.toBe(lineKey('a', [], 'com sal'));
  });

  test('totais: preço do prato mais extras, vezes a quantidade', () => {
    const l = line({ itemId: 'a', unitCents: 850_000, quantity: 2, options: [{ id: 'o', name: 'Funge extra', deltaCents: 100_000 }] });
    expect(lineTotal(l)).toBe(1_900_000);
    const m = line({ itemId: 'b', unitCents: 180_000, quantity: 3 });
    expect(cartSubtotal([l, m])).toBe(1_900_000 + 540_000);
    expect(cartUnits([l, m])).toBe(5);
  });

  test('o que se envia ao servidor leva só escolhas, nunca preços', () => {
    const payload = toPayload(
      [line({ itemId: 'a', quantity: 2, notes: '  sem gindungo ', options: [{ id: 'o1', name: 'Funge extra', deltaCents: 100_000 }] }), line({ itemId: 'b' })],
      '  mesa junto à janela ',
    );
    expect(payload).toEqual({
      items: [
        { menu_item_id: 'a', quantity: 2, notes: 'sem gindungo', options: [{ option_id: 'o1', quantity: 1 }] },
        { menu_item_id: 'b', quantity: 1, options: [] },
      ],
      notes: 'mesa junto à janela',
    });
    expect(JSON.stringify(payload)).not.toContain('Cents');
    expect(JSON.stringify(payload)).not.toContain('price');
    expect(toPayload([line({ itemId: 'a' })], '   ')).not.toHaveProperty('notes');
  });
});

describe('o menu mudou enquanto o cliente escolhia', () => {
  test('tudo igual: nada muda', () => {
    const r = reconcileCart([line({ itemId: 'a' })], menuOf(item({ id: 'a', name: 'Prato' })));
    expect(r.changed).toBe(false);
    expect(r.notices).toEqual([]);
  });

  test('prato esgotado ou apagado sai do pedido, com aviso', () => {
    const lines = [line({ itemId: 'a', name: 'Lagosta' }), line({ itemId: 'b', name: 'Sopa' }), line({ itemId: 'c', name: 'Pudim' })];
    const r = reconcileCart(lines, menuOf(item({ id: 'a', name: 'Lagosta', available: false }), item({ id: 'c', name: 'Pudim' })));
    expect(r.lines.map((l) => l.itemId)).toEqual(['c']);
    expect(r.changed).toBe(true);
    expect(r.notices).toHaveLength(2);
    expect(r.notices.join(' ')).toContain('Lagosta');
    expect(r.notices.join(' ')).toContain('Sopa');
  });

  test('preço novo: atualiza e avisa', () => {
    const r = reconcileCart([line({ itemId: 'a', unitCents: 100_000 })], menuOf(item({ id: 'a', price_cents: 120_000 })));
    expect(r.lines[0]!.unitCents).toBe(120_000);
    expect(r.notices[0]).toContain('mudou');
  });

  test('extra que deixou de existir sai; se a linha ficar igual a outra, juntam-se', () => {
    const withExtra = line({ itemId: 'a', quantity: 2, options: [{ id: 'gone', name: 'Ovo', deltaCents: 50_000 }] });
    const plain = line({ itemId: 'a', quantity: 3 });
    const r = reconcileCart([plain, withExtra], menuOf(item({ id: 'a' })));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.quantity).toBe(5);
    expect(r.lines[0]!.options).toEqual([]);
    expect(r.notices.join(' ')).toContain('Ovo');
  });

  test('a quantidade juntada nunca passa do limite por linha', () => {
    const r = reconcileCart(
      [line({ itemId: 'a', quantity: 15 }), line({ itemId: 'a', quantity: 15, options: [{ id: 'gone', name: 'Ovo', deltaCents: 0 }] })],
      menuOf(item({ id: 'a' })),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.quantity).toBe(20);
  });
});

describe('pratos com tamanhos', () => {
  const pizza = item({
    id: 'p',
    name: 'Pizza',
    options: [
      { id: 's1', name: 'Pequena', price_delta_cents: 0, kind: 'size' },
      { id: 's2', name: 'Grande', price_delta_cents: 200_000, kind: 'size' },
      { id: 'e1', name: 'Queijo extra', price_delta_cents: 50_000, kind: 'extra' },
    ],
  });
  test('uma linha antiga sem tamanho é retirada e a pessoa é avisada', () => {
    const r = reconcileCart([line({ itemId: 'p', name: 'Pizza' })], menuOf(pizza));
    expect(r.lines).toEqual([]);
    expect(r.notices[0]).toContain('tem tamanhos');
  });
  test('com exatamente um tamanho a linha fica; com dois ou com um tamanho que já não existe, não', () => {
    const ok = line({ itemId: 'p', name: 'Pizza', options: [{ id: 's2', name: 'Grande', deltaCents: 200_000 }, { id: 'e1', name: 'Queijo extra', deltaCents: 50_000 }] });
    expect(reconcileCart([ok], menuOf(pizza)).lines).toHaveLength(1);
    const two = line({ itemId: 'p', name: 'Pizza', options: [{ id: 's1', name: 'Pequena', deltaCents: 0 }, { id: 's2', name: 'Grande', deltaCents: 200_000 }] });
    expect(reconcileCart([two], menuOf(pizza)).lines).toEqual([]);
    const gone = line({ itemId: 'p', name: 'Pizza', options: [{ id: 's9', name: 'Gigante', deltaCents: 400_000 }] });
    expect(reconcileCart([gone], menuOf(pizza)).lines).toEqual([]);
  });
});

describe('quando o cliente vê os botões de pedir', () => {
  const base = menuOf();
  const withCaps = (caps: Partial<PublicMenu['capabilities']>, over: { accepting?: boolean; demo?: boolean } = {}): PublicMenu => ({
    ...base,
    accepting_orders: over.accepting ?? true,
    capabilities: { ...base.capabilities, ...caps },
    restaurant: { ...base.restaurant, is_demo: over.demo ?? false },
  });

  test('pedidos pelo sistema ativos: vê os botões', () => {
    expect(cartAvailable(withCaps({ orders: true, whatsapp: false }))).toBe(true);
  });
  test('pedidos por QR Code pausados e sem WhatsApp: só consulta o cardápio', () => {
    expect(cartAvailable(withCaps({ orders: true, whatsapp: false }, { accepting: false }))).toBe(false);
  });
  test('pedidos por QR Code pausados mas com WhatsApp: continua a poder montar o pedido e enviá-lo por WhatsApp', () => {
    expect(cartAvailable(withCaps({ orders: true, whatsapp: true }, { accepting: false }))).toBe(true);
  });
  test('página do restaurante (sem mesa) só com WhatsApp: vê os botões; sem WhatsApp, não', () => {
    expect(cartAvailable(withCaps({ orders: false, whatsapp: true }))).toBe(true);
    expect(cartAvailable(withCaps({ orders: false, whatsapp: false }))).toBe(false);
  });
  test('plano sem pedidos nem WhatsApp: só consulta', () => {
    expect(cartAvailable(withCaps({ orders: false, whatsapp: false }, { accepting: true }))).toBe(false);
  });
  test('cardápio de demonstração: o carrinho serve para experimentar, mesmo sem poder enviar', () => {
    expect(cartAvailable(withCaps({ orders: false, whatsapp: false }, { demo: true }))).toBe(true);
    expect(cartAvailable(withCaps({ orders: false, whatsapp: false }, { demo: true, accepting: false }))).toBe(true);
  });
});
