import { describe, expect, test } from 'bun:test';
import { summarizePayments } from './payments';

describe('resumo de pagamentos de um pedido', () => {
  test('sem registos: por pagar, tudo em falta', () => {
    expect(summarizePayments(1_000_000, [])).toEqual({ state: 'pendente', paid_cents: 0, due_cents: 1_000_000 });
  });

  test('pagamento completo', () => {
    expect(summarizePayments(1_000_000, [{ status: 'pago', amount_cents: 1_000_000 }])).toEqual({ state: 'pago', paid_cents: 1_000_000, due_cents: 0 });
  });

  test('pagamento em duas partes: parcial e depois pago', () => {
    const first = { status: 'pago' as const, amount_cents: 400_000 };
    expect(summarizePayments(1_000_000, [first])).toEqual({ state: 'parcial', paid_cents: 400_000, due_cents: 600_000 });
    expect(summarizePayments(1_000_000, [first, { status: 'pago', amount_cents: 600_000 }]).state).toBe('pago');
  });

  test('isento: nada a receber', () => {
    expect(summarizePayments(1_000_000, [{ status: 'isento', amount_cents: 0 }])).toEqual({ state: 'isento', paid_cents: 0, due_cents: 0 });
  });

  test('reembolsado e anulado não contam como recebido', () => {
    expect(summarizePayments(1_000_000, [{ status: 'reembolsado', amount_cents: 1_000_000 }])).toEqual({ state: 'reembolsado', paid_cents: 0, due_cents: 1_000_000 });
    expect(summarizePayments(1_000_000, [{ status: 'anulado', amount_cents: 1_000_000 }])).toEqual({ state: 'pendente', paid_cents: 0, due_cents: 1_000_000 });
  });

  test('pagar de novo depois de reembolsar volta a "pago"', () => {
    const rows = [
      { status: 'reembolsado' as const, amount_cents: 500_000 },
      { status: 'pago' as const, amount_cents: 500_000 },
    ];
    expect(summarizePayments(500_000, rows).state).toBe('pago');
  });

  test('um pedido de valor zero nunca aparece como pago sem registo', () => {
    expect(summarizePayments(0, []).state).toBe('pendente');
  });
});
