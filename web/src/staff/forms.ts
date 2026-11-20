// Pequenos auxiliares dos formulários da equipa.
import { ApiError } from '../lib/api';

/** Erros por campo devolvidos pela API (ex.: { name: "Campo obrigatório." }). */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.details)) {
    for (const d of err.details as Array<{ field?: unknown; message?: unknown }>) {
      if (d && typeof d.field === 'string' && typeof d.message === 'string' && !(d.field in out)) out[d.field] = d.message;
    }
  }
  return out;
}

/** Remove acentos e maiúsculas, para procurar "feijao" e encontrar "Feijão". */
export function plain(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Troca dois vizinhos de uma lista ordenada e devolve só os "display_order" que mudam (de 10 em 10, para haver espaço). */
export function reorderUpdates<T extends { id: string; display_order: number }>(list: T[], index: number, dir: -1 | 1): Array<{ id: string; display_order: number }> {
  const j = index + dir;
  if (j < 0 || j >= list.length) return [];
  const next = [...list];
  [next[index], next[j]] = [next[j]!, next[index]!];
  const before = new Map(list.map((x) => [x.id, x.display_order]));
  return next.map((x, i) => ({ id: x.id, display_order: (i + 1) * 10 })).filter((u) => before.get(u.id) !== u.display_order);
}

/** Um número de posição para um item novo ficar no fim da lista. */
export function nextOrder(list: Array<{ display_order: number }>): number {
  return list.reduce((m, x) => Math.max(m, x.display_order), 0) + 10;
}

/** "12" → 12. Devolve null se não for um número inteiro entre 1 e 9999 (os limites da API). */
export function parseTableNumber(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 9999 ? n : null;
}

/** O número seguinte ao maior que já existe (ou 1, se ainda não há mesas). */
export function nextTableNumber(tables: Array<{ table_number: number }>): number {
  return Math.min(9999, tables.reduce((m, t) => Math.max(m, t.table_number), 0) + 1);
}

/** "1, 2 e 3" — para frases como "Já existem as mesas 1, 2 e 3". */
export function listPt(items: Array<string | number>): string {
  const xs = items.map(String);
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`;
}

/** "10" → 1000, "12,5" → 1250, "7.5 %" → 750 (pontos base). Devolve null se não for uma percentagem de 0 a 30. */
export function parsePercentToBps(text: string): number | null {
  const t = text.replace('%', '').trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= 0 && bps <= 3000 ? bps : null;
}

/** 1250 → "12,5" */
export const bpsToPercentText = (bps: number): string => String(bps / 100).replace('.', ',');
