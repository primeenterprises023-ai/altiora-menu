// Gera web/public/landing/og.jpg (imagem de pré-visualização quando a página é partilhada), a partir de og.html.
// Só é preciso para refazer a imagem; o resultado já está no projeto. Requer Playwright (Chromium) e sharp.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const require = createRequire(process.env.TOOLS_DIR ?? '/opt/npm-tools/');
const { chromium } = require('playwright');
const sharp = require('sharp');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`file://${join(here, 'og.html')}`);
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png' });
await browser.close();
const out = join(root, 'web/public/landing/og.jpg');
await sharp(png).jpeg({ quality: 88, mozjpeg: true }).toFile(out);
console.log('escrito', out);
