// Dinheiro: sempre em CÊNTIMOS (inteiros). 1 Kz = 100 cêntimos.

/** Símbolo mostrado a seguir ao valor, por moeda (todas com 2 casas decimais). Outras moedas: o código de 3 letras. */
const CURRENCY_SYMBOLS: Record<string, string> = { AOA: 'Kz', USD: 'US$', EUR: '\u20ac', BRL: 'R$', MZN: 'MT', ZAR: 'R', GBP: '\u00a3' };

/** O símbolo da moeda ("Kz", "€"…); para moedas sem símbolo conhecido, o código de 3 letras. */
export function currencySymbol(currency: string = 'AOA'): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

/** Formata cêntimos na moeda indicada: (450000, 'AOA') -> "4 500 Kz"; (1250, 'EUR') -> "12,50 €". Os espaços são espaços sem quebra (U+00A0). */
export function formatMoney(cents: number, currency: string = 'AOA'): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${negative ? '-' : ''}${grouped}${frac ? ',' + String(frac).padStart(2, '0') : ''}\u00a0${CURRENCY_SYMBOLS[currency] ?? currency}`;
}

/** Formata cêntimos como Kwanzas: 450000 -> "4 500 Kz"; 450050 -> "4 500,50 Kz". */
export function formatKz(cents: number): string {
  return formatMoney(cents, 'AOA');
}

/**
 * Converte o texto digitado pelo gerente em cêntimos. Devolve null se for inválido ou ambíguo.
 * Convenção portuguesa/angolana: a vírgula separa os decimais e o ponto agrupa milhares.
 *   "4500" → 450000 · "4 500,50" → 450050 · "4.500" → 450000 · "4.500,5 Kz" → 450050
 * Um ponto só conta como separador decimal quando não há vírgula e tem 1 ou 2 dígitos depois ("4.5" → 4,50 Kz),
 * para que "4.5" nunca seja lido como 45 Kz.
 */
export function parseKzToCents(input: string): number | null {
  const text = input.replace(/[\s\u00a0]/g, '').replace(/kz$/i, '');
  let normalized: string;
  if (text.includes(',')) {
    const parts = text.split(',');
    if (parts.length !== 2) return null;
    const [whole, frac] = parts as [string, string];
    if (!/^\d+$/.test(whole) && !/^\d{1,3}(\.\d{3})+$/.test(whole)) return null;
    normalized = whole.replace(/\./g, '') + '.' + frac;
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    normalized = text.replace(/\./g, '');
  } else {
    normalized = text;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [w, f = ''] = normalized.split('.');
  const cents = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Taxa de serviço em pontos-base (1000 = 10 %), arredondada para o cêntimo mais próximo (meio para cima). */
export function serviceFeeCents(subtotalCents: bigint, bps: number): bigint {
  return (subtotalCents * BigInt(bps) + HALF_BPS_UNIT) / BPS_UNIT;
}
// Sem literais "123n": o código da aplicação web é compilado para telemóveis antigos, onde esse formato nem sequer é lido.
const BPS_UNIT = BigInt(10000);
const HALF_BPS_UNIT = BigInt(5000);
