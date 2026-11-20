import { describe, expect, test } from 'bun:test';
import { alignmentPositions, byteCapacity, encodeQr, qrLayout, qrPath, qrSvg, reedSolomonRemainder, type EccLevel, type QrCode } from './qr';

const LEVELS: EccLevel[] = ['L', 'M', 'Q', 'H'];

// Posições dos padrões de alinhamento: tabela da norma ISO/IEC 18004 (anexo E), escrita à mão.
const ALIGNMENT_TABLE: Record<number, number[]> = {
  1: [],
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
  21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114], 27: [6, 34, 62, 90, 118],
  28: [6, 26, 50, 74, 98, 122], 29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130], 31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138], 33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146],
  35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154], 37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162], 39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
};

// Capacidade em bytes (modo "bytes"), tabela da norma, para algumas versões.
const BYTE_CAPACITY: Array<[number, EccLevel, number]> = [
  [1, 'L', 17], [1, 'M', 14], [1, 'Q', 11], [1, 'H', 7],
  [2, 'L', 32], [2, 'M', 26], [2, 'Q', 20], [2, 'H', 14],
  [3, 'M', 42], [4, 'M', 62], [5, 'M', 84], [6, 'M', 106],
  [7, 'M', 122], [10, 'L', 271], [10, 'M', 213], [10, 'Q', 151], [10, 'H', 119],
  [40, 'L', 2953], [40, 'M', 2331], [40, 'Q', 1663], [40, 'H', 1273],
];

/** Marca os módulos que não carregam dados, com base apenas na geometria descrita na norma. */
function functionMask(version: number): boolean[][] {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y]![x] = true;
  };
  rect(0, 0, 8, 8); // canto superior esquerdo: localizador, separador e informação de formato
  rect(size - 8, 0, size - 1, 8); // superior direito
  rect(0, size - 8, 8, size - 1); // inferior esquerdo (inclui o módulo escuro fixo)
  rect(6, 0, 6, size - 1); // linha de sincronismo vertical
  rect(0, 6, size - 1, 6); // linha de sincronismo horizontal
  const pos = ALIGNMENT_TABLE[version]!;
  pos.forEach((cx, i) =>
    pos.forEach((cy, j) => {
      const onFinder = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (!onFinder) rect(cx - 2, cy - 2, cx + 2, cy + 2);
    }),
  );
  if (version >= 7) {
    rect(size - 11, 0, size - 9, 5);
    rect(0, size - 11, 5, size - 9);
  }
  return m;
}

const dark = (q: QrCode, x: number, y: number): number => (q.isDark(x, y) ? 1 : 0);

/** Lê os 15 bits de formato (primeira cópia, à volta do localizador superior esquerdo). */
function readFormat(q: QrCode): number {
  let bits = 0;
  const cells: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) cells.push([8, i]);
  cells.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) cells.push([14 - i, 8]);
  cells.forEach(([x, y], i) => {
    bits |= dark(q, x, y) << i;
  });
  return bits;
}

/** Resto da divisão BCH (polinómio gerador dado), para validar formato e versão. */
function bchRemainder(value: number, generator: number, genBits: number): number {
  let rem = value;
  for (let i = 31 - Math.clz32(rem); i >= genBits - 1; i--) if ((rem >>> i) & 1) rem ^= generator << (i - (genBits - 1));
  return rem;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Um leitor mínimo, escrito à parte do gerador: lê o formato, tira a máscara, reúne os bytes pela ordem em zigue-zague,
 * desentrelaça os blocos, confere a correção de erros de cada um e devolve o texto. Serve de rede de segurança nos testes.
 */
function decode(q: QrCode): { ecc: EccLevel; mask: number; text: string } {
  const raw = readFormat(q) ^ 0x5412;
  const eccBits = (raw >>> 13) & 3;
  const mask = (raw >>> 10) & 7;
  const ecc = ({ 1: 'L', 0: 'M', 3: 'Q', 2: 'H' } as Record<number, EccLevel>)[eccBits]!;
  const fn = functionMask(q.version);
  const { size } = q;

  // pares de colunas da direita para a esquerda; o primeiro sobe, o seguinte desce, e assim por diante (a coluna 6 salta-se)
  const bits: number[] = [];
  let pair = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = pair % 2 === 0;
    pair++;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (const x of [right, right - 1]) {
        if (fn[y]![x]) continue;
        bits.push(dark(q, x, y) ^ (MASKS[mask]!(x, y) ? 1 : 0));
      }
    }
  }
  const { rawCodewords, numBlocks, eccPerBlock } = qrLayout(q.version, ecc);
  const codewords: number[] = [];
  for (let i = 0; i < rawCodewords; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]!;
    codewords.push(b);
  }

  // desentrelaçar
  const shortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen - eccPerBlock + 1; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i === shortLen - eccPerBlock && b < shortBlocks) continue;
      blocks[b]!.push(codewords[k++]!);
    }
  }
  const eccParts: number[][] = Array.from({ length: numBlocks }, () => []);
  for (let i = 0; i < eccPerBlock; i++) for (let b = 0; b < numBlocks; b++) eccParts[b]!.push(codewords[k++]!);
  expect(k).toBe(rawCodewords);

  const data: number[] = [];
  blocks.forEach((block, b) => {
    expect(Array.from(reedSolomonRemainder(block, eccPerBlock))).toEqual(eccParts[b]!);
    data.push(...block);
  });

  // ler o texto (modo "bytes")
  const stream: number[] = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) stream.push((byte >>> i) & 1);
  let p = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | stream[p++]!;
    return v;
  };
  expect(take(4)).toBe(0b0100);
  const count = take(q.version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = take(8);
  return { ecc, mask, text: new TextDecoder().decode(bytes) };
}

describe('Reed-Solomon', () => {
  test('dá os códigos de correção do exemplo clássico (versão 1-M, "HELLO WORLD")', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(Array.from(reedSolomonRemainder(data, 10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test('os bytes de dados mais os de correção formam uma palavra de código válida (resto zero)', () => {
    const data = [64, 86, 134, 87, 38, 150, 150, 224, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236];
    const ecc = Array.from(reedSolomonRemainder(data, 7));
    expect(Array.from(reedSolomonRemainder([...data, ...ecc], 7))).toEqual(new Array(7).fill(0));
  });
});

describe('tabelas da norma', () => {
  for (const [version, level, capacity] of BYTE_CAPACITY) {
    test(`versão ${version}, nível ${level} cabe ${capacity} bytes`, () => {
      expect(byteCapacity(version, level)).toBe(capacity);
    });
  }

  test('as posições dos padrões de alinhamento coincidem com a norma, nas 40 versões', () => {
    for (let v = 1; v <= 40; v++) expect(alignmentPositions(v)).toEqual(ALIGNMENT_TABLE[v]!);
  });

  test('os módulos livres da geometria coincidem com os da fórmula da norma, nas 40 versões', () => {
    for (let v = 1; v <= 40; v++) {
      const fn = functionMask(v);
      const free = fn.flat().filter((f) => !f).length;
      expect(free).toBe(qrLayout(v, 'M').rawModules);
    }
  });

  test('o total de palavras de código e a capacidade crescem sempre com a versão', () => {
    for (const level of LEVELS) {
      let before = 0;
      for (let v = 1; v <= 40; v++) {
        const cap = byteCapacity(v, level);
        expect(cap).toBeGreaterThan(before);
        before = cap;
      }
    }
  });
});

describe('estrutura da matriz', () => {
  test('o lado é 4 × versão + 17 e a versão é a menor que cabe', () => {
    for (const [text, version] of [['a', 1], ['x'.repeat(14), 1], ['x'.repeat(15), 2], ['x'.repeat(26), 2], ['x'.repeat(27), 3]] as const) {
      const q = encodeQr(text, 'M');
      expect(q.version).toBe(version);
      expect(q.size).toBe(version * 4 + 17);
    }
  });

  test('tem os três localizadores, as linhas de sincronismo e o módulo escuro fixo', () => {
    for (const v of [1, 2, 7, 14, 40]) {
      const q = encodeQr('https://exemplo.ao/menu/abc', 'Q', v);
      const { size } = q;
      for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
        for (let dy = 0; dy < 7; dy++) {
          for (let dx = 0; dx < 7; dx++) {
            const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
            expect(q.isDark(ox + dx, oy + dy)).toBe(ring !== 2);
          }
        }
      }
      for (let i = 8; i < size - 8; i++) {
        expect(q.isDark(6, i)).toBe(i % 2 === 0);
        expect(q.isDark(i, 6)).toBe(i % 2 === 0);
      }
      expect(q.isDark(8, size - 8)).toBe(true);
    }
  });

  test('os padrões de alinhamento estão desenhados (anel escuro, anel claro, centro escuro)', () => {
    const q = encodeQr('x', 'L', 10);
    const pos = ALIGNMENT_TABLE[10]!;
    for (const cx of pos) {
      for (const cy of pos) {
        if ((cx === 6 && cy === 6) || (cx === 6 && cy === pos[pos.length - 1]) || (cx === pos[pos.length - 1] && cy === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) expect(q.isDark(cx + dx, cy + dy)).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  });

  test('a informação de formato é um código BCH válido e diz o nível e a máscara usados', () => {
    for (const level of LEVELS) {
      const q = encodeQr('https://exemplo.ao/menu/xyz', level);
      const raw = readFormat(q) ^ 0x5412;
      expect(bchRemainder(raw, 0x537, 11)).toBe(0);
      expect(({ 1: 'L', 0: 'M', 3: 'Q', 2: 'H' } as Record<number, string>)[(raw >>> 13) & 3]).toBe(level);
      expect((raw >>> 10) & 7).toBe(q.mask);
    }
  });

  test('a segunda cópia da informação de formato é igual à primeira', () => {
    const q = encodeQr('https://exemplo.ao/menu/xyz', 'H');
    const { size } = q;
    let second = 0;
    for (let i = 0; i < 8; i++) second |= dark(q, size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) second |= dark(q, 8, size - 15 + i) << i;
    expect(second).toBe(readFormat(q));
  });

  test('a informação de versão (a partir da 7) é um código BCH válido nas duas cópias', () => {
    for (const v of [7, 8, 12, 21, 33, 40]) {
      const q = encodeQr('x', 'L', v);
      let a = 0;
      let b = 0;
      for (let i = 0; i < 18; i++) {
        a |= dark(q, q.size - 11 + (i % 3), Math.floor(i / 3)) << i;
        b |= dark(q, Math.floor(i / 3), q.size - 11 + (i % 3)) << i;
      }
      expect(a).toBe(b);
      expect(a >>> 12).toBe(v);
      expect(bchRemainder(a, 0x1f25, 13)).toBe(0);
    }
  });

  test('fora da matriz tudo é claro', () => {
    const q = encodeQr('x');
    expect(q.isDark(-1, 0)).toBe(false);
    expect(q.isDark(0, -1)).toBe(false);
    expect(q.isDark(q.size, 0)).toBe(false);
    expect(q.isDark(0, q.size)).toBe(false);
  });
});

describe('ida e volta com o leitor de teste', () => {
  const samples = [
    '',
    'a',
    'https://exemplo.ao/menu/Zq3n9sTt1y0bWm8kLr4vXe7uHc2dFg5pJa6oNi1R',
    'Terraço do Mar, Luanda — mesa 7',
    'Pão de ló 🍰 e café ☕',
    'x'.repeat(100),
  ];

  test('todas as versões em todos os níveis de correção descodificam para o mesmo texto', () => {
    for (const level of LEVELS) {
      for (let v = 1; v <= 40; v++) {
        const text = `https://pedidos.exemplo.ao/menu/${'k'.repeat(Math.max(0, byteCapacity(v, level) - 40))}`.slice(0, byteCapacity(v, level));
        const q = encodeQr(text, level, v);
        expect(q.version).toBe(v);
        const out = decode(q);
        expect(out.ecc).toBe(level);
        expect(out.mask).toBe(q.mask);
        expect(out.text).toBe(text);
      }
    }
  });

  test.each(samples)('texto %#', (text) => {
    for (const level of LEVELS) {
      const q = encodeQr(text, level);
      expect(decode(q).text).toBe(text);
    }
  });

  test('os endereços de menu reais (≈ 90 caracteres) cabem numa versão pequena e legível', () => {
    const url = 'https://pedidos-altiora.onrender.com/menu/' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6';
    const q = encodeQr(url, 'M');
    expect(q.version).toBeLessThanOrEqual(6);
    expect(decode(q).text).toBe(url);
  });

  test('o mesmo texto dá sempre a mesma imagem', () => {
    const a = qrSvg(encodeQr('https://exemplo.ao/menu/abc', 'M'));
    const b = qrSvg(encodeQr('https://exemplo.ao/menu/abc', 'M'));
    expect(a).toBe(b);
  });

  test('textos diferentes dão imagens diferentes', () => {
    expect(qrSvg(encodeQr('https://exemplo.ao/menu/abc'))).not.toBe(qrSvg(encodeQr('https://exemplo.ao/menu/abd')));
  });
});

describe('limites', () => {
  test('o texto mais comprido que a versão 40 permite dá erro claro', () => {
    expect(() => encodeQr('x'.repeat(2954), 'L')).toThrow(RangeError);
    expect(() => encodeQr('x'.repeat(1274), 'H')).toThrow(RangeError);
  });

  test('no limite exato ainda cabe', () => {
    const q = encodeQr('x'.repeat(2953), 'L');
    expect(q.version).toBe(40);
    expect(q.size).toBe(177);
    expect(decode(q).text).toBe('x'.repeat(2953));
  });
});

describe('imagem SVG', () => {
  test('tem o tamanho certo (lado + margem de 4 módulos) e só linhas escuras no caminho', () => {
    const q = encodeQr('https://exemplo.ao/menu/abc', 'M');
    const svg = qrSvg(q);
    const side = q.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#000000"');
  });

  test('o caminho cobre exatamente os módulos escuros (nenhum a mais, nenhum a menos)', () => {
    const q = encodeQr('https://exemplo.ao/menu/abc', 'Q');
    const { d, side } = qrPath(q, 4);
    const painted = new Set<string>();
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (let i = 0; i < w; i++) painted.add(`${x + i},${y}`);
    }
    let expected = 0;
    for (let y = 0; y < q.size; y++) {
      for (let x = 0; x < q.size; x++) {
        const has = painted.has(`${x + 4},${y + 4}`);
        expect(has).toBe(q.isDark(x, y));
        if (q.isDark(x, y)) expected++;
      }
    }
    expect(painted.size).toBe(expected);
    expect(side).toBe(q.size + 8);
  });

  test('aceita cores e fundo transparente', () => {
    const q = encodeQr('x');
    const svg = qrSvg(q, { dark: '#112233', light: null, quiet: 2 });
    expect(svg).toContain('fill="#112233"');
    expect(svg).not.toContain('<rect');
    expect(svg).toContain(`viewBox="0 0 ${q.size + 4} ${q.size + 4}"`);
  });
});
