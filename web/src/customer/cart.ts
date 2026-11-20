// Carrinho do cliente. Serve só para mostrar e enviar a escolha: os preços finais são SEMPRE calculados pelo servidor.
import { useCallback, useEffect, useRef, useState } from 'react';
import { serviceFeeCents } from '../../../shared/money';
import type { MenuItem, PublicMenu } from '../../../shared/types';
import { kz } from '../lib/format';
import { local } from '../lib/storage';
import type { OrderPayload } from './data';

export interface CartOption {
  id: string;
  name: string;
  deltaCents: number;
}

export interface CartLine {
  key: string;
  itemId: string;
  name: string;
  unitCents: number;
  quantity: number;
  notes: string;
  options: CartOption[];
}

export const MAX_LINE_QUANTITY = 20;
export const MAX_UNITS = 100;
export const MAX_LINES = 40;
const TTL_MS = 3 * 60 * 60 * 1000;

export const lineKey = (itemId: string, optionIds: string[], notes: string) => `${itemId}|${[...optionIds].sort().join(',')}|${notes.trim().toLowerCase()}`;
export const unitWithOptions = (l: Pick<CartLine, 'unitCents' | 'options'>) => l.unitCents + l.options.reduce((n, o) => n + o.deltaCents, 0);
export const lineTotal = (l: CartLine) => unitWithOptions(l) * l.quantity;
export const cartSubtotal = (lines: CartLine[]) => lines.reduce((n, l) => n + lineTotal(l), 0);
export const cartUnits = (lines: CartLine[]) => lines.reduce((n, l) => n + l.quantity, 0);
/**
 * Taxa de serviço, pela mesma regra do servidor (shared/money.ts: arredonda ao cêntimo, meio para cima).
 * Usa números normais, porque o ecrã não pode depender de BigInt (telemóveis antigos não o têm).
 */
export function feeFor(subtotal: number, bps: number): number {
  const scaled = Math.round(subtotal) * bps + 5000;
  if (!Number.isSafeInteger(scaled)) return Number(serviceFeeCents(BigInt(Math.round(subtotal)), bps));
  return (scaled - (scaled % 10000)) / 10000;
}
export const feeLabel = (bps: number) => `${String(bps / 100).replace('.', ',')} %`;

/**
 * O cliente vê os botões de pedir (e a barra «Ver pedido») só se o pedido tiver por onde seguir:
 * pelo sistema (e o restaurante a receber pedidos por QR Code), por WhatsApp ou, no cardápio de demonstração, só para experimentar.
 * Com os pedidos pausados e sem WhatsApp, o cliente só consulta o cardápio.
 */
export function cartAvailable(menu: Pick<PublicMenu, 'accepting_orders' | 'capabilities'> & { restaurant: Pick<PublicMenu['restaurant'], 'is_demo'> }): boolean {
  return (menu.capabilities.orders && menu.accepting_orders) || menu.capabilities.whatsapp || menu.restaurant.is_demo;
}

export function toPayload(lines: CartLine[], orderNotes: string): OrderPayload {
  return {
    items: lines.map((l) => ({
      menu_item_id: l.itemId,
      quantity: l.quantity,
      ...(l.notes.trim() ? { notes: l.notes.trim() } : {}),
      options: l.options.map((o) => ({ option_id: o.id, quantity: 1 })),
    })),
    ...(orderNotes.trim() ? { notes: orderNotes.trim() } : {}),
  };
}

export interface Reconciled {
  lines: CartLine[];
  notices: string[];
  changed: boolean;
}

/** Compara o carrinho com o menu atual: tira o que acabou ou deixou de existir e atualiza preços. */
export function reconcileCart(lines: CartLine[], menu: PublicMenu): Reconciled {
  const items = new Map<string, MenuItem>();
  for (const c of menu.categories) for (const i of c.items) items.set(i.id, i);
  const notices: string[] = [];
  const out: CartLine[] = [];
  let changed = false;
  for (const l of lines) {
    const item = items.get(l.itemId);
    if (!item) {
      notices.push(`"${l.name}" já não está no menu e foi retirado do pedido.`);
      changed = true;
      continue;
    }
    if (!item.available) {
      notices.push(`"${item.name}" esgotou e foi retirado do pedido.`);
      changed = true;
      continue;
    }
    const byId = new Map(item.options.map((o) => [o.id, o]));
    const options: CartOption[] = [];
    for (const o of l.options) {
      const cur = byId.get(o.id);
      if (!cur) {
        notices.push(`O extra "${o.name}" de "${item.name}" já não existe e foi retirado.`);
        changed = true;
        continue;
      }
      if (cur.price_delta_cents !== o.deltaCents || cur.name !== o.name) changed = true;
      options.push({ id: cur.id, name: cur.name, deltaCents: cur.price_delta_cents });
    }
    // se o prato passou a ter tamanhos, a linha antiga já não é válida: a pessoa escolhe outra vez
    const sizeIds = new Set(item.options.filter((o) => o.kind === 'size').map((o) => o.id));
    if (sizeIds.size > 0 && options.filter((o) => sizeIds.has(o.id)).length !== 1) {
      notices.push(`"${item.name}" tem tamanhos: escolha o tamanho para o voltar a adicionar.`);
      changed = true;
      continue;
    }
    if (item.price_cents !== l.unitCents) {
      notices.push(`O preço de "${item.name}" mudou para ${kz(item.price_cents)}.`);
      changed = true;
    }
    if (item.name !== l.name) changed = true;
    out.push({ ...l, name: item.name, unitCents: item.price_cents, options, key: lineKey(l.itemId, options.map((o) => o.id), l.notes) });
  }
  // linhas que ficaram iguais depois de retirar extras juntam-se
  const merged: CartLine[] = [];
  for (const l of out) {
    const same = merged.find((m) => m.key === l.key);
    if (same) {
      same.quantity = Math.min(MAX_LINE_QUANTITY, same.quantity + l.quantity);
      changed = true;
    } else merged.push({ ...l });
  }
  return { lines: merged, notices, changed };
}

interface Stored {
  at: number;
  lines: CartLine[];
}
const storeKey = (token: string) => `altiora:cart:${token}`;

function load(token: string): CartLine[] {
  const s = local.getJson<Stored>(storeKey(token));
  if (!s || !Array.isArray(s.lines) || Date.now() - s.at > TTL_MS) return [];
  return s.lines.filter(
    (l) => l && typeof l.itemId === 'string' && typeof l.name === 'string' && Number.isFinite(l.unitCents) && Number.isInteger(l.quantity) && l.quantity > 0 && l.quantity <= MAX_LINE_QUANTITY && Array.isArray(l.options),
  );
}

/** `persist = false`: o pedido só existe enquanto o ecrã está aberto (usado pela equipa, em pedidos presenciais). */
export function useCart(token: string, persist = true) {
  const [lines, setLines] = useState<CartLine[]>(() => (persist ? load(token) : []));
  const ref = useRef(lines);
  ref.current = lines;

  useEffect(() => {
    if (!persist) return;
    if (lines.length === 0) local.remove(storeKey(token));
    else local.setJson(storeKey(token), { at: Date.now(), lines } satisfies Stored);
  }, [token, lines, persist]);

  const add = useCallback((line: Omit<CartLine, 'key'>) => {
    setLines((cur) => {
      const key = lineKey(line.itemId, line.options.map((o) => o.id), line.notes);
      const same = cur.find((l) => l.key === key);
      if (same) return cur.map((l) => (l === same ? { ...l, quantity: Math.min(MAX_LINE_QUANTITY, l.quantity + line.quantity) } : l));
      if (cur.length >= MAX_LINES) return cur;
      return [...cur, { ...line, key, quantity: Math.min(MAX_LINE_QUANTITY, line.quantity) }];
    });
  }, []);
  const replace = useCallback((oldKey: string, line: Omit<CartLine, 'key'>) => {
    setLines((cur) => {
      const key = lineKey(line.itemId, line.options.map((o) => o.id), line.notes);
      const without = cur.filter((l) => l.key !== oldKey);
      const same = without.find((l) => l.key === key);
      if (same) return without.map((l) => (l === same ? { ...l, quantity: Math.min(MAX_LINE_QUANTITY, l.quantity + line.quantity) } : l));
      const index = cur.findIndex((l) => l.key === oldKey);
      const next = { ...line, key, quantity: Math.min(MAX_LINE_QUANTITY, line.quantity) };
      const copy = [...without];
      copy.splice(index < 0 ? copy.length : Math.min(index, copy.length), 0, next);
      return copy;
    });
  }, []);
  const setQuantity = useCallback((key: string, quantity: number) => {
    setLines((cur) => (quantity <= 0 ? cur.filter((l) => l.key !== key) : cur.map((l) => (l.key === key ? { ...l, quantity: Math.min(MAX_LINE_QUANTITY, quantity) } : l))));
  }, []);
  const remove = useCallback((key: string) => setLines((cur) => cur.filter((l) => l.key !== key)), []);
  const clear = useCallback(() => setLines([]), []);
  const replaceAll = useCallback((next: CartLine[]) => setLines(next), []);

  return { lines, linesRef: ref, add, replace, setQuantity, remove, clear, replaceAll, units: cartUnits(lines), subtotal: cartSubtotal(lines) };
}
