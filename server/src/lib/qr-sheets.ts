// Folhas de QR Codes em PDF, prontas a imprimir: cartões de mesa (4 por folha A4, com linhas de corte) e a folha do restaurante.
import { encodeQr } from '../../../shared/qr';
import { A4, PdfDocument, hexToRgb, wrapText, type PdfPage, type Rgb } from './pdf';

const INK: Rgb = [0.05, 0.05, 0.06];
const GRAY: Rgb = [0.42, 0.42, 0.46];
const RULE: Rgb = [0.72, 0.72, 0.75];
/** Dourado da marca ALTIORA MENU (usado quando o restaurante não tem cor própria). */
const GOLD: Rgb = [0.788, 0.635, 0.294];

export interface SheetBrand {
  restaurantName: string;
  /** Cor do restaurante (#RRGGBB) ou null para o dourado da marca. */
  accent: string | null;
  /** false = plano com personalização exclusiva: a marca Altiora não aparece. */
  showBrand: boolean;
  created?: Date;
}

export interface TableCard {
  number: number;
  label: string | null;
  url: string;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

function footer(page: PdfPage, cx: number, y: number, url: string, brand: SheetBrand): void {
  page.text(hostOf(url), cx, y, { size: 7, color: GRAY, align: 'center' });
  if (brand.showBrand) page.text('ALTIORA MENU  ·  Digital Dining Experience', cx, y + 3.6, { size: 6, font: 'bold', color: GRAY, align: 'center' });
}

function card(page: PdfPage, x: number, y: number, w: number, h: number, t: TableCard, brand: SheetBrand): void {
  const accent = hexToRgb(brand.accent) ?? GOLD;
  const cx = x + w / 2;
  page.rect(x, y, w, 3, accent);
  const name = wrapText(brand.restaurantName, 15, 'bold', w - 16, 2);
  page.paragraph(name, cx, y + 15, { size: 15, font: 'bold', color: INK, align: 'center', leading: 6.4 });
  page.text(`Mesa ${t.number}`, cx, y + 42, { size: 30, font: 'bold', color: INK, align: 'center' });
  if (t.label) page.text(wrapText(t.label, 10, 'regular', w - 16, 1)[0] ?? '', cx, y + 49, { size: 10, color: GRAY, align: 'center' });
  const side = 62;
  page.qr(encodeQr(t.url, 'M'), cx - side / 2, y + 54, side, { dark: INK });
  page.paragraph(['Aponte a câmara do telemóvel', 'ao QR Code para ver o menu.'], cx, y + 123, { size: 9, color: INK, align: 'center', leading: 4 });
  footer(page, cx, y + h - 9, t.url, brand);
  page.frame(x, y, w, h, RULE, 0.2, [1.5, 1.5]);
}

/** Cartões das mesas: 4 por folha A4 (2 × 2), cada um com o QR Code próprio da mesa. */
export function tableCardsPdf(tables: TableCard[], brand: SheetBrand): Uint8Array<ArrayBuffer> {
  const doc = new PdfDocument({ title: `QR Codes das mesas — ${brand.restaurantName}`, created: brand.created });
  const margin = 10;
  const w = (A4.w - margin * 2) / 2;
  const h = (A4.h - margin * 2) / 2;
  for (let i = 0; i < tables.length; i += 4) {
    const page = doc.addPage();
    tables.slice(i, i + 4).forEach((t, k) => card(page, margin + (k % 2) * w, margin + Math.floor(k / 2) * h, w, h, t, brand));
  }
  if (doc.pageCount === 0) doc.addPage().text('Sem mesas para imprimir.', A4.w / 2, 40, { size: 14, color: GRAY, align: 'center' });
  return doc.build();
}

/** Uma folha com o QR Code do restaurante (abre o menu completo, sem mesa), para a porta, o balcão ou as redes sociais. */
export function restaurantSheetPdf(url: string, brand: SheetBrand): Uint8Array<ArrayBuffer> {
  const doc = new PdfDocument({ title: `QR Code — ${brand.restaurantName}`, created: brand.created });
  const page = doc.addPage();
  const cx = A4.w / 2;
  const accent = hexToRgb(brand.accent) ?? GOLD;
  page.rect(0, 0, A4.w, 8, accent);
  const name = wrapText(brand.restaurantName, 32, 'bold', A4.w - 40, 2);
  const after = page.paragraph(name, cx, 44, { size: 32, font: 'bold', color: INK, align: 'center', leading: 13.5 });
  page.text('O nosso menu', cx, after + 10, { size: 16, color: GRAY, align: 'center' });
  const side = 124;
  page.qr(encodeQr(url, 'M'), cx - side / 2, 92, side, { dark: INK });
  page.paragraph(['Aponte a câmara do telemóvel ao QR Code', 'para ver o menu, sem instalar nada.'], cx, 232, { size: 13, color: INK, align: 'center', leading: 5.6 });
  footer(page, cx, 270, url, brand);
  return doc.build();
}
