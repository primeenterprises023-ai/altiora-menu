import { describe, expect, test } from 'bun:test';
import { formatKz, parseKzToCents, serviceFeeCents } from './money';

const NB = ' '; // espaço que não quebra a linha: "4 500 Kz" nunca fica partido entre duas linhas

describe('formatKz', () => {
  test('mostra Kwanzas com milhares separados e decimais só quando existem', () => {
    const cases: Array<[number, string]> = [
      [0, `0${NB}Kz`],
      [5, `0,05${NB}Kz`],
      [50, `0,50${NB}Kz`],
      [99, `0,99${NB}Kz`],
      [100, `1${NB}Kz`],
      [450000, `4${NB}500${NB}Kz`],
      [450050, `4${NB}500,50${NB}Kz`],
      [450005, `4${NB}500,05${NB}Kz`],
      [100000000, `1${NB}000${NB}000${NB}Kz`],
      [123456789, `1${NB}234${NB}567,89${NB}Kz`],
      [-150000, `-1${NB}500${NB}Kz`],
    ];
    for (const [cents, text] of cases) expect({ cents, text: formatKz(cents) }).toEqual({ cents, text });
  });

  test('cêntimos fracionários (que não devem existir) arredondam em vez de gerar texto estranho', () => {
    expect(formatKz(1050.4)).toBe(`10,50${NB}Kz`);
    expect(formatKz(1050.6)).toBe(`10,51${NB}Kz`);
  });
});

describe('parseKzToCents', () => {
  test('aceita as formas habituais de escrever um preço (vírgula nos decimais, ponto ou espaço nos milhares)', () => {
    const cases: Array<[string, number]> = [
      ['4500', 450000],
      ['4 500', 450000],
      [`4${NB}500`, 450000],
      ['4500,5', 450050],
      ['4 500,50', 450050],
      ['4.500', 450000],
      ['4.500,50', 450050],
      ['4.500,5 Kz', 450050],
      ['1.234.567', 123456700],
      ['12,5 Kz', 1250],
      ['12 KZ', 1200],
      ['  300kz ', 30000],
      ['0', 0],
      ['0,05', 5],
      ['0.5', 50],
      ['4.5', 450], // nunca 45 Kz
      ['4.50', 450],
      ['4500.5', 450050],
    ];
    for (const [text, cents] of cases) expect({ text, cents: parseKzToCents(text) }).toEqual({ text, cents });
  });

  test('recusa o que é inválido ou ambíguo', () => {
    for (const text of ['', ' ', 'abc', '-5', '+5', '4,500,50', '4,5,0', '1,234', '4.50.0', '4..500', '.5', '5.', ',5', '1e3', 'Infinity', '12.34.567', '1.2345', '١٢٣', '4 500 Kz Kz', '9007199254740993', '99999999999999999999']) {
      expect({ text, cents: parseKzToCents(text) }).toEqual({ text, cents: null });
    }
  });

  test('o que se formata volta a ler-se igual', () => {
    for (const cents of [0, 1, 5, 99, 100, 101, 450050, 123456789, 99999999999]) {
      const shown = formatKz(cents).replace(/Kz$/, '');
      expect({ cents, back: parseKzToCents(shown) }).toEqual({ cents, back: cents });
    }
  });
});

describe('serviceFeeCents (taxa de serviço)', () => {
  test('arredonda para o cêntimo mais próximo, com o meio a subir', () => {
    expect(serviceFeeCents(1000n, 1000)).toBe(100n); // 10 %
    expect(serviceFeeCents(5n, 1000)).toBe(1n); // 0,5 → 1
    expect(serviceFeeCents(4n, 1000)).toBe(0n); // 0,4 → 0
    expect(serviceFeeCents(6n, 1000)).toBe(1n); // 0,6 → 1
    expect(serviceFeeCents(120000n, 1250)).toBe(15000n); // 12,5 % de 1 200 Kz = 150 Kz (15000,5 → 15000)
    expect(serviceFeeCents(120001n, 1250)).toBe(15000n);
    expect(serviceFeeCents(120004n, 1250)).toBe(15001n); // 15000,5 → 15001
    expect(serviceFeeCents(999999n, 0)).toBe(0n);
    expect(serviceFeeCents(0n, 3000)).toBe(0n);
  });

  test('coincide com o cálculo de referência em milhares de casos aleatórios', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const subtotal = rnd(2_000_000_000);
      const bps = rnd(3001);
      const reference = Math.floor((subtotal * bps) / 10000 + 0.5);
      expect({ subtotal, bps, fee: serviceFeeCents(BigInt(subtotal), bps) }).toEqual({ subtotal, bps, fee: BigInt(reference) });
    }
  });

  test('funciona com valores enormes sem perder precisão', () => {
    const big = 99_999_999_999_999_999n;
    expect(serviceFeeCents(big, 3000)).toBe((big * 3000n + 5000n) / 10000n);
    expect(serviceFeeCents(big, 3000) < big).toBe(true);
  });
});
