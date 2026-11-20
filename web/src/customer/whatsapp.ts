// Pedido por WhatsApp: o menu escreve a mensagem e abre o WhatsApp do restaurante; o cliente só toca em "Enviar".
// Os valores são indicativos (o servidor não participa): o restaurante confirma o pedido.
import { kz } from '../lib/format';
import { lineTotal, unitWithOptions, type CartLine } from './cart';

export interface WhatsappOrder {
  restaurant: string;
  /** Ex.: "Mesa 4, Esplanada"; null quando o menu foi aberto sem QR Code de mesa. */
  table: string | null;
  lines: CartLine[];
  notes: string;
  fee: { label: string; cents: number } | null;
  total: number;
}

export function whatsappText(o: WhatsappOrder): string {
  const out: string[] = [`*Pedido — ${o.restaurant}*`, o.table ?? 'Sem mesa (pedido para levar ou a combinar)', ''];
  for (const l of o.lines) {
    const extras = l.options.length > 0 ? ` (${l.options.map((x) => x.name).join(', ')})` : '';
    out.push(`${l.quantity}× ${l.name}${extras} — ${kz(lineTotal(l))}`);
    if (l.quantity > 1) out.push(`   ${kz(unitWithOptions(l))} cada`);
    if (l.notes) out.push(`   Nota: ${l.notes}`);
  }
  out.push('');
  if (o.fee && o.fee.cents > 0) out.push(`${o.fee.label}: ${kz(o.fee.cents)}`);
  out.push(`*Total: ${kz(o.total)}*`);
  if (o.notes.trim()) out.push('', `Indicações: ${o.notes.trim()}`);
  out.push('', '_Valores indicativos; o restaurante confirma o pedido._');
  return out.join('\n');
}

/** Só dígitos, com indicativo do país (é o que o servidor guarda). */
export const whatsappUrl = (number: string, text: string): string => `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
