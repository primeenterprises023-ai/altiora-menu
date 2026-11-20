// Escritor de PDF mínimo, sem dependências: páginas, retângulos, linhas, texto (Helvetica) e QR Codes desenhados como vetores.
// Serve para os cartões de QR Codes prontos a imprimir. Medidas em milímetros, com a origem no canto de cima à esquerda
// (como no papel); a conversão para o sistema do PDF (pontos, origem em baixo) é feita aqui dentro.
import { deflateSync } from 'node:zlib';
import type { QrCode } from '../../../shared/qr';

const MM = 72 / 25.4;
export const A4 = { w: 210, h: 297 } as const;

export type FontName = 'regular' | 'bold';
export type Rgb = [number, number, number];

/** "#c9a24b" → [0.79, 0.64, 0.29]; texto inválido → null. */
export function hexToRgb(hex: string | null | undefined): Rgb | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : null;
}

// --- texto -----------------------------------------------------------------------------------------------------------
// Larguras da Helvetica (por 1000 unidades) para ASCII 32–126. As letras acentuadas usam a largura da letra base.
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Largura do texto em milímetros (aproximada: serve para centrar e para quebrar linhas). */
export function textWidth(text: string, size: number, font: FontName = 'regular'): number {
  const table = font === 'bold' ? W_BOLD : W_REGULAR;
  let units = 0;
  for (const ch of text.normalize('NFD')) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x300 && code <= 0x36f) continue; // acento solto: não ocupa espaço
    units += code >= 32 && code <= 126 ? table[code - 32]! : code === 0xb7 ? 278 : code === 0x2013 ? 556 : code === 0x2014 ? 1000 : 556;
  }
  return (units / 1000) * size * (25.4 / 72);
}

/** Parte o texto em linhas que cabem em `maxWidth` mm (no máximo `maxLines`; o que sobra fica com "…"). */
export function wrapText(text: string, size: number, font: FontName, maxWidth: number, maxLines = 3): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (textWidth(next, size, font) <= maxWidth || !current) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1]!;
  while (last.length > 1 && textWidth(`${last}…`, size, font) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

const CP1252_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Texto → bytes em Windows-1252, entre parênteses e com os carateres especiais protegidos (formato de texto do PDF). */
function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const byte = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : (CP1252_EXTRA[cp] ?? 0x3f);
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte === 0x7f) out += ' ';
    else if (byte < 0x80) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

/** Texto dos metadados (título, autor): o PDF pede UTF-16 com marca de ordem, em hexadecimal. */
function metaString(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

const num = (n: number) => (Math.round(n * 1000) / 1000).toString();
const color = (c: Rgb) => `${num(c[0])} ${num(c[1])} ${num(c[2])}`;

// --- páginas ---------------------------------------------------------------------------------------------------------
export class PdfPage {
  private readonly ops: string[] = [];
  constructor(
    readonly width = A4.w,
    readonly height = A4.h,
  ) {}

  private y(mm: number): number {
    return (this.height - mm) * MM;
  }

  /** Retângulo cheio. */
  rect(x: number, y: number, w: number, h: number, fill: Rgb): this {
    this.ops.push(`${color(fill)} rg ${num(x * MM)} ${num(this.y(y + h))} ${num(w * MM)} ${num(h * MM)} re f`);
    return this;
  }

  /** Retângulo só com contorno (opcionalmente tracejado, para linhas de corte). */
  frame(x: number, y: number, w: number, h: number, stroke: Rgb, widthMm = 0.25, dash?: [number, number]): this {
    const d = dash ? `[${num(dash[0] * MM)} ${num(dash[1] * MM)}] 0 d` : '[] 0 d';
    this.ops.push(`q ${color(stroke)} RG ${num(widthMm * MM)} w ${d} ${num(x * MM)} ${num(this.y(y + h))} ${num(w * MM)} ${num(h * MM)} re S Q`);
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: Rgb, widthMm = 0.25): this {
    this.ops.push(`q ${color(stroke)} RG ${num(widthMm * MM)} w ${num(x1 * MM)} ${num(this.y(y1))} m ${num(x2 * MM)} ${num(this.y(y2))} l S Q`);
    return this;
  }

  /** Texto com a linha de base em `y`; `align` refere-se a `x`. `size` em pontos. */
  text(str: string, x: number, y: number, opts: { size: number; font?: FontName; color?: Rgb; align?: 'left' | 'center' | 'right' }): this {
    if (!str) return this;
    const font = opts.font ?? 'regular';
    const w = textWidth(str, opts.size, font);
    const left = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
    this.ops.push(`BT ${color(opts.color ?? [0, 0, 0])} rg /${font === 'bold' ? 'F2' : 'F1'} ${num(opts.size)} Tf ${num(left * MM)} ${num(this.y(y))} Td ${pdfString(str)} Tj ET`);
    return this;
  }

  /** Várias linhas centradas; devolve a posição (mm) logo abaixo da última. */
  paragraph(lines: string[], x: number, y: number, opts: { size: number; font?: FontName; color?: Rgb; align?: 'left' | 'center' | 'right'; leading?: number }): number {
    const step = opts.leading ?? opts.size * 0.42;
    let at = y;
    for (const l of lines) {
      this.text(l, x, at, opts);
      at += step;
    }
    return at;
  }

  /** QR Code como vetores (sequências de módulos escuros viram retângulos). `side` inclui a margem clara. */
  qr(qr: QrCode, x: number, y: number, side: number, opts: { quiet?: number; dark?: Rgb; light?: Rgb | null } = {}): this {
    const quiet = opts.quiet ?? 4;
    const unit = side / (qr.size + quiet * 2);
    if (opts.light !== null) this.rect(x, y, side, side, opts.light ?? [1, 1, 1]);
    const parts: string[] = [`${color(opts.dark ?? [0, 0, 0])} rg`];
    for (let row = 0; row < qr.size; row++) {
      let col = 0;
      while (col < qr.size) {
        if (!qr.isDark(col, row)) {
          col++;
          continue;
        }
        const start = col;
        while (col < qr.size && qr.isDark(col, row)) col++;
        parts.push(`${num((x + (start + quiet) * unit) * MM)} ${num(this.y(y + (row + quiet) * unit + unit))} ${num((col - start) * unit * MM)} ${num(unit * MM)} re`);
      }
    }
    parts.push('f');
    this.ops.push(parts.join(' '));
    return this;
  }

  content(): string {
    return this.ops.join('\n');
  }
}

// --- documento -------------------------------------------------------------------------------------------------------
export class PdfDocument {
  private readonly pages: PdfPage[] = [];
  constructor(private readonly meta: { title: string; author?: string; created?: Date } = { title: '' }) {}

  addPage(width = A4.w, height = A4.h): PdfPage {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** O ficheiro PDF completo. */
  build(): Uint8Array<ArrayBuffer> {
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (b: Buffer) => {
      chunks.push(b);
      length += b.length;
    };
    const text = (s: string) => push(Buffer.from(s, 'latin1'));
    const object = (id: number, body: string | Buffer) => {
      offsets[id] = length;
      text(`${id} 0 obj\n`);
      push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
      text('\nendobj\n');
    };

    // 1 catálogo, 2 páginas, 3-4 tipos de letra, 5 informação; depois, por página: objeto da página + conteúdo
    const n = this.pages.length;
    const pageId = (i: number) => 6 + i * 2;
    text('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Count ${n} /Kids [${this.pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
    object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const d = this.meta.created ?? new Date();
    const stamp = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
    object(5, `<< /Title ${metaString(this.meta.title)} /Author ${metaString(this.meta.author ?? 'ALTIORA MENU')} /Producer ${metaString('ALTIORA MENU')} /CreationDate (${stamp}) >>`);
    this.pages.forEach((page, i) => {
      const id = pageId(i);
      object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width * MM)} ${num(page.height * MM)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`);
      const stream = deflateSync(Buffer.from(page.content(), 'latin1'));
      object(id + 1, Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
    });

    const total = 6 + n * 2;
    const xref = length;
    text(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let id = 1; id < total; id++) text(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    text(`trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const all = Buffer.concat(chunks);
    const out = new Uint8Array(new ArrayBuffer(all.length));
    out.set(all);
    return out;
  }
}
