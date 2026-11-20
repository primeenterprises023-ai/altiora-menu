// Ferramentas comuns dos ensaios de ponta a ponta (Playwright + Chromium).
// Os ensaios correm contra um servidor a sério, com uma base de dados temporária, e usam o sistema como as pessoas o usam.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3111';
export const PASSWORD = process.env.E2E_PASSWORD ?? 'Ensaio-E2E-2026-ok';
export const OUT = process.env.E2E_OUT ?? join(here, 'output');
mkdirSync(OUT, { recursive: true });

/** Um telemóvel normal (390 × 844) e um pequeno (360 × 740), com ecrã tátil, hora e língua de Angola. */
const PHONE_BASE = { deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-AO', timezoneId: 'Africa/Luanda', colorScheme: 'light' };
export const PHONE = { ...PHONE_BASE, viewport: { width: 390, height: 844 } };
export const SMALL_PHONE = { ...PHONE_BASE, viewport: { width: 360, height: 740 } };

// ---------------------------------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------------------------------
const results = [];
export const allResults = () => results;

/** Regista uma verificação. Só mostra o pormenor quando falha. */
export function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  results.push({ name, ok: pass, skipped: false });
  console.log(`${pass ? 'OK     ' : 'FALHA  '}${name}${!pass && detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
  return pass;
}

export function skip(name, why) {
  results.push({ name, ok: true, skipped: true });
  console.log(`SALTADO ${name} — ${why}`);
}

/** Corre um cenário; uma exceção (por exemplo, um ecrã que não aparece) conta como falha mas não impede os outros cenários. */
export async function scenario(title, fn) {
  console.log(`\n== ${title}`);
  try {
    await fn();
  } catch (e) {
    check(`${title}: terminou sem exceções`, false, String(e?.message ?? e).split('\n')[0]);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repete `fn` até devolver algo verdadeiro (ou acabar o tempo). Devolve o valor, ou false. */
export async function until(fn, { timeout = 8000, step = 150 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* ainda não está pronto: tenta outra vez */
    }
    await sleep(step);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Navegador
// ---------------------------------------------------------------------------------------------------
const NETWORK_NOISE = /net::ERR_|Failed to fetch|NetworkError|Load failed/i;
// o Chromium regista na consola cada resposta 4xx: nos ensaios de erros isso é esperado
const EXPECTED_HTTP_ERRORS = /Failed to load resource: the server responded with a status of 4\d\d/;

/**
 * Junta a `bucket` o que um ecrã imprime de errado: exceções e erros da consola.
 * `network: true` aceita erros de rede (ensaios com a ligação cortada de propósito).
 */
export function watch(page, bucket, { network = false } = {}) {
  page.on('pageerror', (e) => bucket.push(`erro de página: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (EXPECTED_HTTP_ERRORS.test(text)) return;
    if (network && NETWORK_NOISE.test(text)) return;
    bucket.push(`consola: ${text}`);
  });
}

/** Qualquer diálogo do navegador (alert, confirm…) quase de certeza é código injetado por alguém: regista-o e fecha-o. */
export function trapDialogs(page, bucket) {
  page.on('dialog', async (d) => {
    bucket.push(`diálogo: ${d.message()}`);
    await d.dismiss().catch(() => undefined);
  });
}

export async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
}

/** Fotografa o ecrã. As animações acabam antes da fotografia (senão uma folha a subir ou a descer sai a meio, esbatida). */
export async function shot(page, name, opts = {}) {
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', ...opts });
}

// ---------------------------------------------------------------------------------------------------
// Sessões da equipa e chamadas à API (para preparar cenários e conferir resultados)
// ---------------------------------------------------------------------------------------------------
export async function loginPage(page, email, password = PASSWORD) {
  await page.goto(`${BASE}/entrar`);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Palavra-passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/entrar'), { timeout: 15000 });
}

const jsonHeaders = { origin: BASE, 'content-type': 'application/json' };

/** Cliente de API com sessão iniciada (sem ecrã). `call(método, caminho, corpo)` devolve { status, json, text }. */
export async function apiAs(browser, email, password = PASSWORD) {
  const ctx = await browser.newContext();
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email, password }, headers: jsonHeaders });
  if (!login.ok()) throw new Error(`início de sessão de ${email}: ${login.status()} ${await login.text()}`);
  const user = (await login.json()).user;
  const call = (method, path, data) => rawCall(ctx.request, method, path, data);
  return { call, ctx, user };
}

export async function rawCall(request, method, path, data, extraHeaders = {}) {
  const res = await request.fetch(`${BASE}${path}`, { method, headers: { ...jsonHeaders, ...extraHeaders }, ...(data !== undefined ? { data } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* não é JSON */
  }
  return { status: res.status(), json, text, headers: res.headers() };
}

let keyCounter = 0;
export const newKey = () => `e2e-${Date.now().toString(36)}-${(keyCounter++).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Endereços (e códigos) dos QR Codes das mesas, lidos pela API do gerente. */
export async function loadTables(manager) {
  const { json } = await manager.call('GET', '/api/tables');
  const byNumber = new Map();
  for (const t of json.tables) {
    const token = t.qr_url.split('/menu/')[1];
    byNumber.set(t.table_number, { id: t.id, number: t.table_number, token, url: `${BASE}/menu/${token}` });
  }
  return byNumber;
}

/** Menu público de uma mesa, com os pratos indexados pelo nome. */
export async function publicMenu(request, token) {
  const res = await rawCall(request, 'GET', `/api/public/menu/${token}`);
  if (res.status !== 200) throw new Error(`menu público: ${res.status}`);
  const items = {};
  for (const c of res.json.categories) for (const i of c.items) items[i.name] = i;
  return { restaurant: res.json.restaurant, table: res.json.table, items, raw: res.json };
}

/** Faz um pedido como cliente (pela API). `lines`: [{ name, qty, notes?, options?: [nome] }] */
export async function placeOrder(request, token, lines, notes, key = newKey()) {
  const { items } = await publicMenu(request, token);
  const body = {
    items: lines.map((l) => {
      const it = items[l.name];
      if (!it) throw new Error(`prato inexistente: ${l.name}`);
      return {
        menu_item_id: it.id,
        quantity: l.qty ?? 1,
        ...(l.notes ? { notes: l.notes } : {}),
        options: (l.options ?? []).map((n) => ({ option_id: it.options.find((o) => o.name === n).id, quantity: 1 })),
      };
    }),
    ...(notes ? { notes } : {}),
  };
  const res = await rawCall(request, 'POST', `/api/public/menu/${token}/orders`, body, { 'idempotency-key': key });
  return { ...res, order: res.json?.order, key };
}

/** Estado de um pedido segundo a API pública (o que o cliente vê). */
export async function publicOrder(request, code) {
  const res = await rawCall(request, 'GET', `/api/public/orders/${code}`);
  return res.status === 200 ? res.json.order : null;
}

/** Pedidos em curso (visão da equipa), opcionalmente de uma mesa. */
export async function activeOrders(staff, tableId) {
  const res = await staff.call('GET', `/api/orders?scope=active${tableId ? `&table_id=${tableId}` : ''}`);
  return res.json?.orders ?? [];
}

// ---------------------------------------------------------------------------------------------------
// Dinheiro (a mesma regra do servidor: taxa de serviço arredondada ao cêntimo, meio para cima)
// ---------------------------------------------------------------------------------------------------
export const kz = (cents) => {
  const whole = Math.floor(Math.abs(cents) / 100);
  const frac = Math.abs(cents) % 100;
  return `${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${frac ? ',' + String(frac).padStart(2, '0') : ''} Kz`;
};
export const feeOf = (subtotal, bps) => Math.floor((subtotal * bps + 5000) / 10000);

// ---------------------------------------------------------------------------------------------------
// Leitura de QR Codes com o OpenCV (um leitor independente do gerador do sistema)
// ---------------------------------------------------------------------------------------------------
const DECODER = join(here, 'decode_qr.py');
let decoderState = null;
export function qrReaderAvailable() {
  if (decoderState === null) {
    try {
      execFileSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' });
      decoderState = true;
    } catch {
      decoderState = false;
    }
  }
  return decoderState;
}
/** Lê o QR Code de uma imagem. Devolve o texto, ou '' se não conseguir. */
export function decodeQr(imagePath) {
  try {
    return execFileSync('python3', [DECODER, imagePath], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    return '';
  }
}
/** Lê os seis QR Codes (2 × 3) de uma folha A4 impressa, por ordem; devolve só os que conseguiu ler. */
export function decodeQrSheet(imagePath) {
  try {
    return execFileSync('python3', [DECODER, imagePath, '--cells'], { encoding: 'utf8' })
      .split('\n')
      .slice(0, 6)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
/** O pdftoppm (do pacote poppler) serve para transformar o PDF impresso em imagens. */
export function pdfRasterizerAvailable() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
