import { describe, expect, test } from 'bun:test';
import { actorRoleLabel, describeActivity } from './activity';

const nb = (s: string) => s.replace(/ /g, ' ');

describe('describeActivity: frases que o gerente entende', () => {
  test('menu', () => {
    expect(describeActivity('menu.category.create', { name: 'Sobremesas' })).toBe('Criou a categoria «Sobremesas».');
    expect(describeActivity('menu.category.create', {})).toBe('Criou a categoria.');
    expect(nb(describeActivity('menu.item.create', { name: 'Muamba', price_cents: 450_000 }))).toBe('Criou o prato «Muamba» (4 500 Kz).');
    expect(nb(describeActivity('menu.item.update', { price_change: { from: 450_000, to: 500_000 } }))).toBe('Alterou um prato: o preço passou de 4 500 Kz para 5 000 Kz.');
    expect(describeActivity('menu.item.update', { fields: ['name'] })).toBe('Alterou um prato do menu.');
    expect(describeActivity('menu.item.update', { price_change: { from: 450_000, to: 450_000 } })).toBe('Alterou um prato do menu.'); // preço igual: não é uma mudança de preço
    expect(describeActivity('menu.item.availability', { available: false })).toBe('Marcou um prato como esgotado.');
    expect(describeActivity('menu.item.availability', { available: true })).toBe('Voltou a marcar um prato como disponível.');
    expect(describeActivity('asset.upload', { kind: 'model' })).toBe('Enviou um modelo 3D.');
    expect(describeActivity('asset.upload', { kind: 'image' })).toBe('Enviou uma fotografia.');
  });

  test('mesas, QR Codes e chamadas ao garçom (com o artigo certo)', () => {
    expect(describeActivity('table.create', { table_number: 4 })).toBe('Criou a mesa 4.');
    expect(describeActivity('table.create', {})).toBe('Criou uma mesa.');
    expect(describeActivity('table.update', { table_number: 4, active: false, active_changed: true })).toBe('Desativou a mesa 4.');
    expect(describeActivity('table.update', { table_number: 4, active: true, active_changed: true })).toBe('Reativou a mesa 4.');
    expect(describeActivity('table.update', { table_number: 4, label_changed: true })).toBe('Mudou o nome da mesa 4.');
    expect(describeActivity('table.update', {})).toBe('Alterou uma mesa.');
    expect(describeActivity('table.qr_regenerated', { table_number: 7 })).toBe('Gerou um novo QR Code para a mesa 7. O anterior deixou de funcionar.');
    expect(describeActivity('waiter_call.attend', { table_number: 3 })).toBe('Atendeu o chamamento da mesa 3.');
    expect(describeActivity('waiter_call.attend', {})).toBe('Atendeu o chamamento de uma mesa.');
    expect(describeActivity('qr.download', { kind: 'tables', count: 1 })).toBe('Descarregou o PDF dos QR Codes de 1 mesa.');
    expect(describeActivity('qr.download', { kind: 'tables', count: 12 })).toBe('Descarregou o PDF dos QR Codes de 12 mesas.');
    expect(describeActivity('qr.download', { kind: 'restaurant' })).toBe('Descarregou o PDF do QR Code do restaurante.');
  });

  test('pedidos e pagamentos registados pela equipa', () => {
    expect(describeActivity('order.cancel', { reason: 'Cliente saiu' })).toBe('Cancelou um pedido (motivo: Cliente saiu).');
    expect(describeActivity('order.correct', { from: 'pronto', to: 'em_preparacao', reason: 'Engano' })).toBe('Corrigiu o estado de um pedido: de «Pronto» para «Em preparação» (motivo: Engano).');
    expect(nb(describeActivity('payment.record', { method: 'dinheiro', amount_cents: 150_000 }))).toBe('Registou um pagamento de 1 500 Kz (dinheiro).');
    expect(describeActivity('payment.exempt', { reason: 'Cortesia da casa' })).toBe('Registou um pedido como isento de pagamento (motivo: Cortesia da casa).');
    expect(nb(describeActivity('payment.refund', { amount_cents: 100_000 }))).toBe('Registou um reembolso de 1 000 Kz.');
    expect(describeActivity('payment.void', {})).toBe('Anulou um registo de pagamento.');
  });

  test('equipa, acessos e definições', () => {
    expect(describeActivity('staff.create', { role: 'waiter' })).toBe('Criou uma conta de empregado de mesa.');
    expect(describeActivity('staff.update', { role: { from: 'waiter', to: 'kitchen' }, active: { to: false } })).toBe('Alterou uma conta da equipa: função de empregado de mesa para cozinha; conta desativada.');
    expect(describeActivity('staff.password_reset', {})).toBe('Repôs a palavra-passe de uma conta da equipa.');
    expect(describeActivity('auth.login', {})).toBe('Iniciou sessão.');
    expect(describeActivity('auth.password_changed', {})).toBe('Mudou a própria palavra-passe.');
    expect(describeActivity('restaurant.update', { accepting_orders: false })).toBe('Pausou os pedidos por QR Code.');
    expect(describeActivity('restaurant.update', { accepting_orders: true })).toBe('Retomou os pedidos por QR Code.');
    expect(describeActivity('restaurant.update', { service_fee_bps: 1250 })).toBe('Alterou a taxa de serviço para 12,5 %.');
    expect(describeActivity('restaurant.update', { fields: ['description'] })).toBe('Alterou as definições do restaurante.');
    expect(describeActivity('report.export', { from: '2026-11-01', to: '2026-11-14' })).toBe('Exportou o relatório de vendas em CSV (01/11/2026 a 14/11/2026).');
  });

  test('dados em falta ou estranhos nunca estragam a frase', () => {
    expect(describeActivity('menu.category.create', null)).toBe('Criou a categoria.');
    expect(describeActivity('menu.category.create', 'texto')).toBe('Criou a categoria.');
    expect(describeActivity('menu.category.create', { name: 42 })).toBe('Criou a categoria.');
    expect(describeActivity('menu.item.update', { price_change: 'x' })).toBe('Alterou um prato do menu.');
    expect(describeActivity('staff.create', { role: 'constructor' })).toBe('Criou uma conta de equipa.');
    expect(describeActivity('payment.record', { method: 'toString', amount_cents: 'muito' })).toBe('Registou um pagamento.');
    expect(describeActivity('order.correct', { from: 'toString', to: 7 })).toBe('Corrigiu o estado de um pedido.');
    expect(describeActivity('qr.download', { kind: 'tables', count: 'x' })).toBe('Descarregou o PDF dos QR Codes das mesas.');
  });

  test('nomes longos são cortados e o código desconhecido fica à vista', () => {
    expect(describeActivity('menu.category.create', { name: 'x'.repeat(300) })).toBe(`Criou a categoria «${'x'.repeat(80)}».`);
    expect(describeActivity('algo.novo', {})).toBe('Ação registada (algo.novo).');
  });

  test('perfis', () => {
    expect(actorRoleLabel('manager')).toBe('Gerente');
    expect(actorRoleLabel('waiter')).toBe('Empregado de mesa');
    expect(actorRoleLabel('kitchen')).toBe('Cozinha');
    expect(actorRoleLabel(null)).toBe('');
    expect(actorRoleLabel('platform')).toBe('');
  });
});
