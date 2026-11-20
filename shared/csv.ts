// Exportação do relatório de vendas em CSV: ";" como separador e vírgula decimal, como o Excel em português espera.
// O ficheiro é montado no servidor (só sai se o plano incluir "Gestão avançada") a partir do mesmo relatório que se vê no ecrã.
import { currencySymbol } from './money';
import { METHOD_LABEL } from './payments';
import type { SalesReport } from './types';

/** Cêntimos → "1234,50" (sem separador de milhares, para a folha de cálculo poder somar). */
export function csvMoney(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Texto livre para uma célula. Entre aspas se tiver ";", aspas ou quebras de linha; e se começar por = + - @ (ou tabulação),
 * leva um apóstrofo à frente para a folha de cálculo nunca o executar como fórmula.
 */
export function csvText(value: string): string {
  let v = value.replace(/\r?\n/g, ' ').trim();
  if (/^[=+\-@\t]/.test(v)) v = `'${v}`;
  return /[;"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** O relatório inteiro: dia a dia, pagamentos por método e pratos mais vendidos (blocos separados por uma linha em branco). */
export function salesCsv(r: SalesReport): string {
  const sym = currencySymbol(r.range.currency);
  const lines: string[] = [];
  const row = (...cells: string[]) => lines.push(cells.join(';'));

  row('Dia', 'Pedidos (sem cancelados)', `Vendas registadas (${sym})`, `Pagamentos confirmados (${sym})`);
  for (const d of r.by_day) row(d.day, String(d.orders), csvMoney(d.total_cents), csvMoney(d.confirmed_cents));
  row('Total', String(r.sales.orders), csvMoney(r.sales.total_cents), csvMoney(r.payments.confirmed_cents));

  lines.push('');
  row('Pagamentos por método', 'Pagamentos', `Valor (${sym})`);
  for (const m of r.payments.by_method) row(csvText(METHOD_LABEL[m.method] ?? m.method), String(m.count), csvMoney(m.confirmed_cents));

  lines.push('');
  row('Pratos mais vendidos', 'Quantidade', `Total (${sym})`);
  for (const i of r.top_items) row(csvText(i.name), String(i.quantity), csvMoney(i.total_cents));

  // a marca de ordem de bytes (BOM) faz o Excel abrir os acentos em UTF-8 corretamente
  return `﻿${lines.join('\r\n')}\r\n`;
}
