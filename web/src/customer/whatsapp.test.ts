import { describe, expect, test } from 'bun:test';
import { whatsappText, whatsappUrl } from './whatsapp';
import type { CartLine } from './cart';

const line = (over: Partial<CartLine>): CartLine => ({ key: 'k', itemId: 'i', name: 'Prato', unitCents: 100_000, quantity: 1, notes: '', options: [], ...over });

describe('pedido por WhatsApp', () => {
  test('a mensagem lista os pratos, extras, notas, taxa e total', () => {
    const text = whatsappText({
      restaurant: 'Casa Aurora',
      table: 'Mesa 4, Esplanada',
      lines: [line({ name: 'Pizza', quantity: 2, unitCents: 400_000, options: [{ id: 'a', name: 'Grande', deltaCents: 200_000 }, { id: 'b', name: 'Queijo', deltaCents: 50_000 }], notes: 'bem passada' }), line({ name: 'Sumo', unitCents: 150_000 })],
      notes: 'Tudo junto',
      fee: { label: 'Taxa de serviço (10 %)', cents: 150_000 },
      total: 1_800_000,
    });
    expect(text).toContain('*Pedido — Casa Aurora*');
    expect(text).toContain('Mesa 4, Esplanada');
    expect(text).toContain('2× Pizza (Grande, Queijo) — 13 000 Kz');
    expect(text).toContain('Nota: bem passada');
    expect(text).toContain('1× Sumo — 1 500 Kz');
    expect(text).toContain('Taxa de serviço (10 %): 1 500 Kz');
    expect(text).toContain('*Total: 18 000 Kz*');
    expect(text).toContain('Indicações: Tudo junto');
    expect(text).toContain('Valores indicativos');
  });
  test('sem mesa, o pedido diz que não há mesa', () => {
    const text = whatsappText({ restaurant: 'R', table: null, lines: [line({})], notes: '', fee: null, total: 100_000 });
    expect(text).toContain('Sem mesa');
    expect(text).not.toContain('Taxa');
  });
  test('o endereço usa só dígitos e codifica o texto', () => {
    const url = whatsappUrl('+244 923 000 111', 'Olá & obrigado\n2× Pizza');
    expect(url.startsWith('https://wa.me/244923000111?text=')).toBe(true);
    expect(url).toContain('Ol%C3%A1%20%26%20obrigado%0A2%C3%97%20Pizza');
  });
});
