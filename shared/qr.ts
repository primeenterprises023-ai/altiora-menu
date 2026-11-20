// Gerador de QR Codes (norma ISO/IEC 18004), escrito de raiz para este projeto: sem dependências, corre no navegador.
// Só usa o modo "bytes" (UTF-8), que serve para qualquer endereço. Versões 1 a 40 e os 4 níveis de correção de erros.
// O resultado é uma matriz de módulos; qrSvg() desenha-a como imagem vetorial (nítida ao imprimir em qualquer tamanho).
//
// Verificação: os testes comparam com valores conhecidos da norma e, fora dos testes, as matrizes geradas para todas as
// versões e níveis foram descodificadas com um leitor independente (OpenCV).

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

const ECC_INDEX: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Bits de formato (norma): L=01, M=00, Q=11, H=10. */
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

// Códigos de correção por bloco e número de blocos, por nível (L, M, Q, H) e versão (índice 0 não se usa).
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Módulos de dados (e correção) de uma versão, sem os padrões fixos. */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number, ecc: EccLevel): number {
  const e = ECC_INDEX[ecc];
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![version]! * NUM_ERROR_CORRECTION_BLOCKS[e]![version]!;
}

const charCountBits = (version: number): number => (version <= 9 ? 8 : 16);

/** Números da norma para uma versão e nível (usados nos testes para conferir a construção). */
export function qrLayout(version: number, ecc: EccLevel): { rawModules: number; rawCodewords: number; dataCodewords: number; numBlocks: number; eccPerBlock: number } {
  const e = ECC_INDEX[ecc];
  return {
    rawModules: numRawDataModules(version),
    rawCodewords: Math.floor(numRawDataModules(version) / 8),
    dataCodewords: numDataCodewords(version, ecc),
    numBlocks: NUM_ERROR_CORRECTION_BLOCKS[e]![version]!,
    eccPerBlock: ECC_CODEWORDS_PER_BLOCK[e]![version]!,
  };
}

/** Quantos bytes cabem no modo "bytes" numa versão e nível de correção. */
export function byteCapacity(version: number, ecc: EccLevel): number {
  return Math.floor((numDataCodewords(version, ecc) * 8 - 4 - charCountBits(version)) / 8);
}

// --- aritmética em GF(256) para o código Reed-Solomon ---------------------------------------------------
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Códigos de correção (Reed-Solomon) para um bloco de dados. */
export function reedSolomonRemainder(data: ArrayLike<number>, degree: number): Uint8Array {
  const divisor = rsDivisor(degree);
  const result = new Uint8Array(degree);
  for (let k = 0; k < data.length; k++) {
    const factor = (data[k]! ^ result[0]!) & 0xff;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i]! ^= gfMultiply(divisor[i]!, factor);
  }
  return result;
}

// --- construção dos dados --------------------------------------------------------------------------------
function buildDataCodewords(bytes: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // modo "bytes"
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminador
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => {
    out[i >>> 3]! |= bit << (7 - (i & 7));
  });
  return out;
}

/** Junta a correção de erros e entrelaça os blocos, como manda a norma. */
function addEccAndInterleave(data: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const e = ECC_INDEX[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dat = Array.from(data.subarray(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)));
    k += dat.length;
    const rem = reedSolomonRemainder(dat, blockEccLen);
    if (i < numShortBlocks) dat.push(0); // marcador de preenchimento (não é transmitido)
    blocks.push(dat.concat(Array.from(rem)));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return Uint8Array.from(result);
}

// --- a matriz ------------------------------------------------------------------------------------------------
export interface QrCode {
  readonly version: number;
  readonly ecc: EccLevel;
  readonly mask: number;
  /** Lado da matriz em módulos (sem margem). */
  readonly size: number;
  /** true se o módulo (coluna x, linha y) é escuro. Fora da matriz é sempre claro. */
  isDark(x: number, y: number): boolean;
}

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const { size, version } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const align = alignmentPositions(version);
    const n = align.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignment(align[i]!, align[j]!);
      }
    }
    this.drawFormat(0, 0); // reserva o espaço; os bits verdadeiros vêm depois da máscara
    this.drawVersion();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawFormat(ecc: EccLevelBits, mask: number): void {
    const data = (ecc << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(bits, i));
    this.setFunction(8, 7, bit(bits, 6));
    this.setFunction(8, 8, bit(bits, 7));
    this.setFunction(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(bits, i));
    this.setFunction(8, size - 8, true); // módulo escuro fixo
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(data: Uint8Array): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFunction[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** Pontuação de penalização da norma: quanto menor, mais fácil de ler. */
  penalty(): number {
    const { size, modules } = this;
    let result = 0;
    const finderPenalty = (runs: number[]): number => {
      const n = runs[1]!;
      const core = n > 0 && runs[2] === n && runs[3] === n * 3 && runs[4] === n && runs[5] === n;
      return (core && runs[0]! >= n * 4 && runs[6]! >= n ? 1 : 0) + (core && runs[6]! >= n * 4 && runs[0]! >= n ? 1 : 0);
    };
    const scanLine = (get: (i: number) => boolean): number => {
      let score = 0;
      let color = false;
      let runX = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = (len: number) => {
        if (history[0] === 0) len += size; // margem clara virtual
        history.pop();
        history.unshift(len);
      };
      for (let i = 0; i < size; i++) {
        if (get(i) === color) {
          runX++;
          if (runX === 5) score += 3;
          else if (runX > 5) score++;
        } else {
          addHistory(runX);
          if (!color) score += finderPenalty(history) * 40;
          color = get(i);
          runX = 1;
        }
      }
      // termina a linha como se houvesse margem clara
      let len = runX;
      if (color) {
        addHistory(len);
        len = 0;
      }
      len += size;
      addHistory(len);
      score += finderPenalty(history) * 40;
      return score;
    };
    for (let y = 0; y < size; y++) result += scanLine((x) => modules[y]![x]!);
    for (let x = 0; x < size; x++) result += scanLine((y) => modules[y]![x]!);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y]![x]!;
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) result += 3;
      }
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}

type EccLevelBits = number;

/** Gera o QR Code de um texto. Escolhe a menor versão que cabe e a melhor máscara. */
export function encodeQr(text: string, ecc: EccLevel = 'M', minVersion = MIN_VERSION): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = Math.max(MIN_VERSION, minVersion);
  while (version <= MAX_VERSION && byteCapacity(version, ecc) < bytes.length) version++;
  if (version > MAX_VERSION) throw new RangeError('O texto é demasiado comprido para um QR Code.');

  const data = buildDataCodewords(bytes, version, ecc);
  const all = addEccAndInterleave(data, version, ecc);
  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(all);

  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    grid.applyMask(mask);
    grid.drawFormat(ECC_FORMAT_BITS[ecc], mask);
    const score = grid.penalty();
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    grid.applyMask(mask); // desfaz (a máscara é o seu próprio inverso)
  }
  grid.applyMask(bestMask);
  grid.drawFormat(ECC_FORMAT_BITS[ecc], bestMask);

  const { size, modules } = grid;
  return {
    version,
    ecc,
    mask: bestMask,
    size,
    isDark: (x, y) => x >= 0 && x < size && y >= 0 && y < size && modules[y]![x]!,
  };
}

export interface QrSvgOptions {
  /** Margem clara em módulos (a norma pede 4). */
  quiet?: number;
  dark?: string;
  light?: string | null;
}

/** Caminho SVG (uma linha por sequência de módulos escuros) e o lado total, para desenhar o QR Code. */
export function qrPath(qr: QrCode, quiet = 4): { d: string; side: number } {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.isDark(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && qr.isDark(x, y)) x++;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  }
  return { d: parts.join(''), side: qr.size + quiet * 2 };
}

/** O QR Code como imagem SVG (texto), pronta a inserir numa página ou a imprimir. */
export function qrSvg(qr: QrCode, opts: QrSvgOptions = {}): string {
  const quiet = opts.quiet ?? 4;
  const { d, side } = qrPath(qr, quiet);
  const light = opts.light === undefined ? '#ffffff' : opts.light;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="QR Code">` +
    (light ? `<rect width="${side}" height="${side}" fill="${light}"/>` : '') +
    `<path d="${d}" fill="${opts.dark ?? '#000000'}"/></svg>`
  );
}
