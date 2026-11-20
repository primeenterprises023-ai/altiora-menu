import { describe, expect, test } from 'bun:test';
import { csvMoney, csvText, salesCsv } from './csv';
import type { SalesReport } from './types';

const report = (over: Partial<SalesReport> = {}): SalesReport => ({
  range: { from: '2026-11-01', to: '2026-11-02', timezone: 'Africa/Luanda', currency: 'AOA' },
  sales: { orders: 3, units: 7, subtotal_cents: 1_000_000, service_fee_cents: 100_000, total_cents: 1_100_050, average_ticket_cents: 366_683 },
  cancelled: { orders: 1, total_cents: 50_000 },
  payments: { confirmed_cents: 900_000, refunded_cents: 0, by_method: [{ method: 'dinheiro', count: 2, confirmed_cents: 900_000 }] },
  outstanding_cents: 200_050,
  exempt_orders: 0,
  by_day: [
    { day: '2026-11-01', orders: 2, total_cents: 800_000, confirmed_cents: 900_000 },
    { day: '2026-11-02', orders: 1, total_cents: 300_050, confirmed_cents: 0 },
  ],
  top_items: [{ name: 'Muamba de galinha', quantity: 4, total_cents: 600_000 }],
  ...over,
});

describe('csvMoney', () => {
  test('cêntimos em número com vírgula decimal, sem separador de milhares', () => {
    expect(csvMoney(0)).toBe('0,00');
    expect(csvMoney(5)).toBe('0,05');
    expect(csvMoney(450_050)).toBe('4500,50');
    expect(csvMoney(123_456_789)).toBe('1234567,89');
    expect(csvMoney(-1250)).toBe('-12,50');
  });
});

describe('csvText', () => {
  test('texto simples passa tal e qual', () => {
    expect(csvText('Muamba de galinha')).toBe('Muamba de galinha');
  });
  test('separadores e aspas ficam entre aspas', () => {
    expect(csvText('Arroz; feijão')).toBe('"Arroz; feijão"');
    expect(csvText('O "melhor" prato')).toBe('"O ""melhor"" prato"');
  });
  test('quebras de linha viram espaços (uma linha por registo)', () => {
    expect(csvText('a\r\nb\nc')).toBe('a b c');
  });
  test('nunca começa por um carácter que a folha de cálculo execute como fórmula', () => {
    expect(csvText('=1+1')).toBe("'=1+1");
    expect(csvText('+244 923')).toBe("'+244 923");
    expect(csvText('-cmd')).toBe("'-cmd");
    expect(csvText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvText('=HYPERLINK("http://x";"y")')).toBe('"\'=HYPERLINK(""http://x"";""y"")"');
  });
});

describe('salesCsv', () => {
  test('três blocos, BOM, ";" e CRLF, na moeda do restaurante', () => {
    const csv = salesCsv(report());
    expect(csv.startsWith('﻿Dia;Pedidos (sem cancelados);Vendas registadas (Kz);Pagamentos confirmados (Kz)\r\n')).toBe(true);
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines).toEqual([
      'Dia;Pedidos (sem cancelados);Vendas registadas (Kz);Pagamentos confirmados (Kz)',
      '2026-11-01;2;8000,00;9000,00',
      '2026-11-02;1;3000,50;0,00',
      'Total;3;11000,50;9000,00',
      '',
      'Pagamentos por método;Pagamentos;Valor (Kz)',
      'Dinheiro;2;9000,00',
      '',
      'Pratos mais vendidos;Quantidade;Total (Kz)',
      'Muamba de galinha;4;6000,00',
      '',
    ]);
  });

  test('outra moeda muda o símbolo dos cabeçalhos', () => {
    const csv = salesCsv(report({ range: { from: '2026-11-01', to: '2026-11-02', timezone: 'Europe/Lisbon', currency: 'EUR' } }));
    expect(csv).toContain('Vendas registadas (€)');
    expect(csv).not.toContain('(Kz)');
  });

  test('um nome de prato malicioso não vira fórmula', () => {
    const csv = salesCsv(report({ top_items: [{ name: '=cmd|\' /C calc\'!A0', quantity: 1, total_cents: 100 }] }));
    expect(csv).toContain("'=cmd|' /C calc'!A0;1;1,00");
  });

  test('sem pagamentos nem pratos, os blocos aparecem só com o cabeçalho', () => {
    const csv = salesCsv(report({ payments: { confirmed_cents: 0, refunded_cents: 0, by_method: [] }, top_items: [] }));
    expect(csv).toContain('Pagamentos por método;Pagamentos;Valor (Kz)\r\n\r\nPratos mais vendidos;Quantidade;Total (Kz)\r\n');
  });
});
