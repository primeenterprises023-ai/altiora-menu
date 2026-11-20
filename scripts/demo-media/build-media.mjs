// Gera as imagens e os modelos 3D do restaurante de demonstração «Casa Aurora» (ILUSTRAÇÕES geradas por computador, não fotografias).
// Só é preciso para refazer os ficheiros; o resultado já está em scripts/demo-media/assets/ e é usado por `bun run seed:demo`.
//
//   node scripts/demo-media/build-media.mjs sheet [pratos,separados,por,virgula]   → folha de contactos (para ver o resultado)
//   node scripts/demo-media/build-media.mjs dishes [pratos...]                      → imagens, miniaturas e modelos GLB dos pratos
//
// Requer Playwright (Chromium) e sharp instalados; TOOLS_DIR aponta para a pasta onde estão (por omissão /opt/npm-tools/).
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(here, 'assets');
const require = createRequire(process.env.TOOLS_DIR ?? '/opt/npm-tools/');
const { chromium } = require('playwright');
const sharp = require('sharp');

const [mode = 'sheet', ...rest] = process.argv.slice(2);
const only = rest.length ? rest.join(',').split(',').filter(Boolean) : null;
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.mjs': 'text/javascript' };

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1800 } });
page.on('pageerror', (e) => console.error('erro na página:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('consola:', m.text()); });
await page.route('http://media.local/**', (route) => {
  const path = new URL(route.request().url()).pathname;
  const file = path === '/' ? join(here, 'dishes.html') : path.startsWith('/vendor/') ? join(root, 'web/vendor', path.slice('/vendor/'.length)) : null;
  if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: 'não encontrado' });
  return route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
});

if (mode === 'sheet') {
  await page.setViewportSize({ width: 2400, height: 1500 });
  await page.goto(`http://media.local/?sheet${only ? `&only=${only.join(',')}` : ''}`);
  await page.waitForFunction(() => document.title === 'pronto', null, { timeout: 180_000 });
  const target = process.env.SHEET_OUT ?? join(here, 'sheet.png');
  await page.screenshot({ path: target, fullPage: true });
  console.log('escrito', target);
} else if (mode === 'dishes') {
  mkdirSync(out, { recursive: true });
  await page.goto('http://media.local/');
  await page.waitForFunction(() => document.title === 'pronto', null, { timeout: 60_000 });
  const ids = await page.evaluate(() => window.dishes.ids);
  const manifestPath = join(out, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { dishes: {} };
  for (const id of ids) {
    if (only && !only.includes(id)) continue;
    const url = await page.evaluate((d) => window.dishes.render(d, 1200, 900, 2), id);
    const png = Buffer.from(url.split(',')[1], 'base64');
    const big = await sharp(png).resize(1200, 900, { kernel: 'lanczos3' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const small = await sharp(png).resize(480, 360, { kernel: 'lanczos3' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    writeFileSync(join(out, `${id}.jpg`), big);
    writeFileSync(join(out, `${id}-thumb.jpg`), small);
    const entry = { image: `${id}.jpg`, thumb: `${id}-thumb.jpg`, model: null };
    if (await page.evaluate((d) => window.dishes.hasModel(d), id)) {
      const glb = Buffer.from(await page.evaluate((d) => window.dishes.glb(d), id), 'base64');
      writeFileSync(join(out, `${id}.glb`), glb);
      entry.model = `${id}.glb`;
      console.log(`${id}: imagem ${(big.length / 1024).toFixed(0)} kB, miniatura ${(small.length / 1024).toFixed(0)} kB, modelo ${(glb.length / 1024).toFixed(0)} kB`);
    } else {
      console.log(`${id}: imagem ${(big.length / 1024).toFixed(0)} kB, miniatura ${(small.length / 1024).toFixed(0)} kB`);
    }
    manifest.dishes[id] = entry;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
} else if (mode === 'cover') {
  mkdirSync(out, { recursive: true });
  await page.goto('http://media.local/');
  await page.waitForFunction(() => document.title === 'pronto', null, { timeout: 60_000 });
  const url = await page.evaluate(() => window.dishes.cover(1600, 900, 2));
  const png = Buffer.from(url.split(',')[1], 'base64');
  const jpg = await sharp(png).resize(1600, 900, { kernel: 'lanczos3' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  writeFileSync(join(out, 'cover.jpg'), jpg);
  console.log(`capa: ${(jpg.length / 1024).toFixed(0)} kB`);
} else if (mode === 'logo') {
  mkdirSync(out, { recursive: true });
  const logoPage = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await logoPage.goto(`file://${join(here, 'logo.html')}`);
  const png = await logoPage.screenshot({ type: 'png' });
  writeFileSync(join(out, 'logo.png'), await sharp(png).png({ compressionLevel: 9 }).toBuffer());
  console.log('logótipo escrito');
} else {
  console.error('Modo desconhecido:', mode);
  process.exitCode = 1;
}
await browser.close();
