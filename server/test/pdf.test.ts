// PDF dos QR Codes: estrutura do ficheiro, texto, o QR Code desenhado igual ao gerado, e o download pelo gerente (permissões e plano).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { encodeQr, type QrCode } from '../../shared/qr';
import { A4, PdfDocument, hexToRgb, textWidth, wrapText } from '../src/lib/pdf';
import { clearFeatureCache } from '../src/lib/plans';
import { restaurantSheetPdf, tableCardsPdf } from '../src/lib/qr-sheets';
import { seedFullRestaurant, seedPlatformAdmin, startTestApp, type Client, type TestApp } from './helpers';

const MM = 72 / 25.4;
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** Verifica o esqueleto do PDF: cabeçalho, fim, e cada entrada da tabela de referências aponta para o objeto certo. */
function checkStructure(bytes: Uint8Array): { pages: number } {
  const s = latin1(bytes);
  expect(s.startsWith('%PDF-1.4\n')).toBe(true);
  expect(s.endsWith('%%EOF\n')).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  expect(s.slice(startxref, startxref + 5)).toBe('xref\n');
  const head = /xref\n0 (\d+)\n/.exec(s.slice(startxref))!;
  const count = Number(head[1]);
  const first = startxref + head[0].length;
  expect(s.slice(first, first + 20)).toBe('0000000000 65535 f \n');
  for (let id = 1; id < count; id++) {
    const entry = s.slice(first + id * 20, first + id * 20 + 20);
    expect(entry).toMatch(/^\d{10} 00000 n \n$/);
    const at = Number(entry.slice(0, 10));
    expect(s.slice(at, at + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
  }
  expect(s).toContain(`/Size ${count}`);
  return { pages: Number(/\/Type \/Pages \/Count (\d+)/.exec(s)![1]) };
}

/** Descomprime os conteúdos das páginas (um texto por página). */
function pageContents(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const a = buf.indexOf('stream\n', from, 'latin1');
    if (a < 0) break;
    const b = buf.indexOf('\nendstream', a, 'latin1');
    out.push(inflateSync(buf.subarray(a + 7, b)).toString('latin1'));
    from = b + 10;
  }
  return out;
}

/** Lê de volta os módulos escuros do QR Code a partir dos retângulos do PDF (independente de quem os desenhou). */
function modulesFromContent(content: string, at: { x: number; y: number; side: number }, qr: QrCode, quiet = 4): boolean[][] {
  const op = content.split('\n').sort((p, q) => q.split(' re').length - p.split(' re').length)[0]!;
  const unit = at.side / (qr.size + quiet * 2);
  const grid = Array.from({ length: qr.size }, () => Array<boolean>(qr.size).fill(false));
  for (const m of op.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)) {
    const [x, y, w, h] = [Number(m[1]) / MM, Number(m[2]) / MM, Number(m[3]) / MM, Number(m[4]) / MM];
    const top = A4.h - y - h;
    const col = Math.round((x - at.x) / unit) - quiet;
    const row = Math.round((top - at.y) / unit) - quiet;
    const run = Math.round(w / unit);
    expect(Math.round(h / unit)).toBe(1);
    for (let i = 0; i < run; i++) grid[row]![col + i] = true;
  }
  return grid;
}

describe('escritor de PDF', () => {
  test('o ficheiro tem estrutura válida (referências certas) e o número de páginas pedido', () => {
    const doc = new PdfDocument({ title: 'Teste', created: new Date('2026-11-14T10:00:00Z') });
    doc.addPage().rect(10, 10, 50, 20, [1, 0, 0]).text('Olá', 20, 40, { size: 12 });
    doc.addPage().line(0, 0, 100, 100, [0, 0, 0]).frame(5, 5, 20, 20, [0, 0, 0], 0.3, [2, 2]);
    const bytes = doc.build();
    expect(checkStructure(bytes).pages).toBe(2);
    expect(latin1(bytes)).toContain('/CreationDate (D:20261114100000Z)');
    expect(latin1(bytes)).toContain('/Title <FEFF00540065007300740065>'); // «Teste» em UTF-16
    expect(pageContents(bytes)).toHaveLength(2);
  });

  test('o título aceita acentos e travessões (UTF-16 nos metadados)', () => {
    const doc = new PdfDocument({ title: 'Mesas — Açaí' });
    doc.addPage();
    const m = /\/Title <FEFF([0-9A-F]+)>/.exec(latin1(doc.build()))!;
    const units = m[1]!.match(/.{4}/g)!.map((h) => parseInt(h, 16));
    expect(String.fromCharCode(...units)).toBe('Mesas — Açaí');
  });

  test('o texto vai em Windows-1252, com os caracteres especiais protegidos', () => {
    const doc = new PdfDocument({ title: 'x' });
    doc.addPage().text('Açaí (x) \\ — “ok” 日', 10, 10, { size: 10 });
    const content = pageContents(doc.build())[0]!;
    expect(content).toContain('(A\\347a\\355 \\(x\\) \\\\ \\227 \\223ok\\224 ?)');
  });

  test('medir e quebrar texto: as linhas cabem na largura e o excesso fica com reticências', () => {
    expect(textWidth('Mesa 12', 30, 'bold')).toBeGreaterThan(textWidth('Mesa 12', 30, 'regular') - 0.001);
    expect(textWidth('ção', 10)).toBeCloseTo(textWidth('cao', 10), 5); // o acento não ocupa largura
    const lines = wrapText('Restaurante Terraza Talatona Terra e Mar de Luanda e arredores com nome muito longo', 15, 'bold', 60, 2);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(textWidth(l, 15, 'bold')).toBeLessThanOrEqual(60 + 0.001);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect(wrapText('Curto', 15, 'bold', 60, 2)).toEqual(['Curto']);
    expect(wrapText('', 15, 'bold', 60, 2)).toEqual([]);
  });

  test('cores em hexadecimal', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(hexToRgb('laranja')).toBeNull();
    expect(hexToRgb(null)).toBeNull();
  });

  test('o QR Code desenhado no PDF é exatamente o QR Code gerado (módulo a módulo)', () => {
    for (const url of ['https://menu.exemplo.ao/menu/' + 'a'.repeat(43), 'https://x.co/r/demo', 'https://altiora.example/menu/' + 'Zk3_-'.repeat(12)]) {
      const qr = encodeQr(url, 'M');
      const doc = new PdfDocument({ title: 'qr' });
      const at = { x: 23.5, y: 41.25, side: 87.3 };
      doc.addPage().qr(qr, at.x, at.y, at.side);
      const bytes = doc.build();
      checkStructure(bytes);
      const grid = modulesFromContent(pageContents(bytes)[0]!, at, qr);
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) expect(grid[y]![x]).toBe(qr.isDark(x, y));
    }
  });
});

describe('folhas de QR Codes', () => {
  const brand = { restaurantName: 'Terraza Talatona — Terra & Mar', accent: '#0e6f7e', showBrand: true, created: new Date('2026-11-14T10:00:00Z') };
  const url = (n: number) => `https://menu.exemplo.ao/menu/token-da-mesa-${n}-${'x'.repeat(30)}`;

  test('4 cartões por folha A4: 9 mesas ocupam 3 folhas e cada cartão traz o seu QR Code', () => {
    const tables = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, label: i === 1 ? 'Esplanada' : null, url: url(i + 1) }));
    const bytes = tableCardsPdf(tables, brand);
    expect(checkStructure(bytes).pages).toBe(3);
    const pages = pageContents(bytes);
    expect(pages[0]).toContain('(Mesa 1)');
    expect(pages[0]).toContain('(Mesa 4)');
    expect(pages[0]).not.toContain('(Mesa 5)');
    expect(pages[0]).toContain('(Esplanada)');
    expect(pages[2]).toContain('(Mesa 9)');
    expect(pages[0]).toContain('ALTIORA MENU');
    expect(pages[0]).toContain('menu.exemplo.ao'); // o endereço também aparece escrito, para quem não consegue ler o QR Code
  });

  test('plano com personalização exclusiva: a marca Altiora não aparece', () => {
    const bytes = tableCardsPdf([{ number: 1, label: null, url: url(1) }], { ...brand, showBrand: false });
    expect(pageContents(bytes).join('')).not.toContain('ALTIORA');
    expect(pageContents(restaurantSheetPdf('https://menu.exemplo.ao/r/demo', { ...brand, showBrand: false })).join('')).not.toContain('ALTIORA');
  });

  test('sem mesas: uma folha com aviso (nunca um PDF vazio)', () => {
    const bytes = tableCardsPdf([], brand);
    expect(checkStructure(bytes).pages).toBe(1);
    expect(pageContents(bytes)[0]).toContain('Sem mesas');
  });

  test('o QR Code de cada cartão corresponde ao endereço da mesa (cartão 1 e cartão 4 da folha)', () => {
    const tables = Array.from({ length: 4 }, (_, i) => ({ number: i + 1, label: null, url: url(i + 1) }));
    const content = pageContents(tableCardsPdf(tables, brand))[0]!;
    // posições definidas em qr-sheets.ts: margem 10 mm, cartão (95 × 138,5), QR de 62 mm a 54 mm do topo do cartão
    const w = (A4.w - 20) / 2;
    const h = (A4.h - 20) / 2;
    const blocks = content.split('\n').filter((l) => (l.match(/ re/g)?.length ?? 0) > 100);
    expect(blocks).toHaveLength(4);
    tables.forEach((t, k) => {
      const qr = encodeQr(t.url, 'M');
      const at = { x: 10 + (k % 2) * w + w / 2 - 31, y: 10 + Math.floor(k / 2) * h + 54, side: 62 };
      const grid = modulesFromContent(blocks[k]!, at, qr);
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) expect(grid[y]![x]).toBe(qr.isDark(x, y));
    });
  });
});

describe('descarregar os QR Codes (gerente)', () => {
  let t: TestApp;
  let P: Awaited<ReturnType<typeof seedFullRestaurant>>;
  let S: Awaited<ReturnType<typeof seedFullRestaurant>>;
  let pm: Client;
  let pw: Client;
  let pk: Client;
  let sm: Client;

  beforeAll(async () => {
    t = await startTestApp();
    P = await seedFullRestaurant(t, 'Casa Premium', 'p');
    S = await seedFullRestaurant(t, 'Casa Starter', 's');
    await t.db.system((tx) => tx`UPDATE subscriptions SET plan_code = 'starter' WHERE restaurant_id = ${S.restaurantId}`);
    clearFeatureCache();
    await seedPlatformAdmin(t);
    pm = await t.login(P.emails.manager);
    pw = await t.login(P.emails.waiter);
    pk = await t.login(P.emails.kitchen);
    sm = await t.login(S.emails.manager);
  });
  afterAll(() => t.close());

  const download = async (c: Client, path: string) => {
    const r = await c.request('GET', path, { keepOpen: true });
    return { status: r.status, headers: r.headers, bytes: new Uint8Array(await r.res.arrayBuffer()) };
  };

  test('o gerente descarrega o PDF das mesas (ficheiro, sem cache) e o conteúdo é do seu restaurante', async () => {
    const r = await download(pm, '/api/qr/tables.pdf');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="qr-[a-z0-9-]+-mesas\.pdf"$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(checkStructure(r.bytes).pages).toBe(1);
    const text = pageContents(r.bytes).join('\n');
    expect(text).toContain('(Mesa 1)');
    expect(text).toContain('(Mesa 2)');
    expect(text).toContain('(Casa Premium)');
    expect(text).not.toContain('Casa Starter');
  });

  test('o QR Code do PDF abre a mesa certa (o endereço com o código da mesa)', async () => {
    const r = await download(pm, '/api/qr/tables.pdf');
    const content = pageContents(r.bytes)[0]!;
    const base = t.config.publicBaseUrl;
    const w = (A4.w - 20) / 2;
    const h = (A4.h - 20) / 2;
    const blocks = content.split('\n').filter((l) => (l.match(/ re/g)?.length ?? 0) > 100);
    expect(blocks).toHaveLength(2);
    [P.table1, P.table2].forEach((table, k) => {
      const qr = encodeQr(`${base}/menu/${table.token}`, 'M');
      const at = { x: 10 + (k % 2) * w + w / 2 - 31, y: 10 + Math.floor(k / 2) * h + 54, side: 62 };
      const grid = modulesFromContent(blocks[k]!, at, qr);
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) expect(grid[y]![x]).toBe(qr.isDark(x, y));
    });
  });

  test('pode pedir só algumas mesas; mesas de outro restaurante, ou códigos inválidos, são recusados', async () => {
    const one = await download(pm, `/api/qr/tables.pdf?ids=${P.table2.id}`);
    expect(one.status).toBe(200);
    const text = pageContents(one.bytes).join('\n');
    expect(text).toContain('(Mesa 2)');
    expect(text).not.toContain('(Mesa 1)');
    expect((await pm.get(`/api/qr/tables.pdf?ids=${S.table1.id}`)).status).toBe(404);
    const bad = await pm.get('/api/qr/tables.pdf?ids=nao-e-um-id');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_IDS');
  });

  test('a folha do restaurante abre a página pública (/r/<identificador>)', async () => {
    const r = await download(pm, '/api/qr/restaurant.pdf');
    expect(r.status).toBe(200);
    expect(checkStructure(r.bytes).pages).toBe(1);
    const slug = (await pm.get('/api/restaurants/current')).body.restaurant.slug as string;
    const qr = encodeQr(`${t.config.publicBaseUrl}/r/${slug}`, 'M');
    const at = { x: A4.w / 2 - 62, y: 92, side: 124 };
    const grid = modulesFromContent(pageContents(r.bytes)[0]!, at, qr);
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) expect(grid[y]![x]).toBe(qr.isDark(x, y));
  });

  test('só o gerente descarrega: cozinha, empregado e visitantes não', async () => {
    for (const path of ['/api/qr/tables.pdf', '/api/qr/restaurant.pdf']) {
      expect((await pk.get(path)).status).toBe(403);
      expect((await pw.get(path)).status).toBe(403);
      expect((await t.anon().get(path)).status).toBe(401);
    }
  });

  test('plano Starter: tem o QR do restaurante, mas não os QR Codes por mesa', async () => {
    expect((await sm.get('/api/qr/restaurant.pdf')).status).toBe(200);
    const r = await sm.get('/api/qr/tables.pdf');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PLAN_FEATURE');
  });

  test('cada descarga fica no registo de atividade, sem guardar códigos', async () => {
    const rows = await t.db.system((tx) => tx<{ metadata: Record<string, unknown> }>`SELECT metadata FROM audit_logs WHERE restaurant_id = ${P.restaurantId} AND action = 'qr.download'`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(JSON.stringify(row.metadata)).not.toContain(P.table1.token);
  });
});
