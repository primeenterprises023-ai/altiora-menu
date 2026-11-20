// QR Codes: o gerente cria a mesa, o QR Code é lido por um leitor independente (OpenCV) e usado para pedir;
// ao renovar, o antigo deixa de funcionar; e as folhas impressas dão exatamente os endereços das mesas.
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, OUT, PHONE, check, decodeQr, decodeQrSheet, loginPage, pdfRasterizerAvailable, qrReaderAvailable, rawCall, scenario, shot, skip, until, watch } from '../lib.mjs';

const tokenOf = (url) => url.split('/menu/')[1];

export async function run(env) {
  const { browser, manager } = env;

  await scenario('QR Code do gerente: criar a mesa, ler o QR Code com um leitor independente e pedir por ele', async () => {
    if (!qrReaderAvailable()) {
      skip('leitura dos QR Codes com o OpenCV', 'precisa de Python 3 com opencv-python e numpy (ver e2e/README.md)');
      return;
    }
    const problems = [];
    const ctx = await browser.newContext({ ...PHONE, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    watch(page, problems);
    const apiTables = async () => (await manager.call('GET', '/api/tables')).json.tables;
    const maxNo = Math.max(...(await apiTables()).map((t) => t.table_number));

    await loginPage(page, 'gerente@terraza.demo');
    await page.getByRole('link', { name: 'Mesas e QR Codes' }).click();
    await page.waitForSelector('.table-admin');
    await shot(page, 'gerente-1-mesas');

    await page.getByRole('button', { name: 'Nova mesa' }).click();
    await page.waitForSelector('.sheet');
    const suggested = await page.getByLabel('Número da mesa').inputValue();
    check('o número sugerido para a mesa nova é o seguinte ao maior', suggested === String(maxNo + 1), suggested);
    await page.getByLabel('Zona ou nome (opcional)').fill('Balcão');
    await page.getByRole('button', { name: 'Criar mesa' }).click();
    await page.waitForSelector('.qr-big');
    const url = await page.locator('#qr-url').inputValue();
    check('o endereço do QR Code tem o formato /menu/<código longo>', /^https?:\/\/[^/]+\/menu\/[A-Za-z0-9_-]{16,}$/.test(url), url);
    await shot(page, 'gerente-2-qr');

    // 1) o QR Code desenhado no ecrã
    const screenPng = join(OUT, 'qr-ecra.png');
    await page.locator('.qr-frame').screenshot({ path: screenPng });
    check('o QR Code do ecrã, lido pelo OpenCV, dá o endereço certo', decodeQr(screenPng) === url, decodeQr(screenPng));

    // 2) o PNG guardado
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Guardar PNG' }).click()]);
    const savedPng = join(OUT, 'qr-guardado.png');
    await download.saveAs(savedPng);
    check('o PNG guardado tem o nome certo e lê-se com o endereço certo', download.suggestedFilename() === `qr-mesa-${suggested}.png` && decodeQr(savedPng) === url, `${download.suggestedFilename()} ${decodeQr(savedPng)}`);

    // 3) o QR Code serve para pedir: o cliente abre o endereço lido e faz um pedido pelo ecrã
    const decoded = decodeQr(savedPng);
    const cctx = await browser.newContext(PHONE);
    const cp = await cctx.newPage();
    watch(cp, problems);
    await cp.goto(decoded);
    await cp.waitForSelector('.mn-card');
    check('o endereço lido do QR Code abre o menu na mesa nova', new RegExp(`Mesa ${suggested}\\b`, 'i').test(await cp.locator('body').innerText()));
    await cp.getByRole('button', { name: 'Adicionar Pastéis de bacalhau' }).click();
    await cp.getByRole('button', { name: /Ver pedido/ }).click();
    await cp.getByRole('button', { name: /Enviar pedido/ }).click();
    await cp.waitForURL(/\/pedido\//);
    const table = (await apiTables()).find((t) => String(t.table_number) === suggested);
    const got = await until(async () => (await manager.call('GET', `/api/orders?scope=active&table_id=${table.id}`)).json.orders.length === 1, { timeout: 8000 });
    check('o pedido feito pelo QR Code novo chega ao restaurante, na mesa certa', got);

    // 4) renovar o QR Code: o antigo deixa de funcionar e o novo funciona
    await page.getByRole('button', { name: 'Gerar novo QR Code' }).click();
    await page.getByRole('button', { name: 'Gerar novo QR Code' }).last().click();
    await until(async () => (await page.locator('#qr-url').inputValue()) !== url, { timeout: 8000 });
    const url2 = await page.locator('#qr-url').inputValue();
    check('ao renovar, o endereço muda', url2 !== url && tokenOf(url2) !== tokenOf(url));
    const oldRes = await rawCall(ctx.request, 'GET', `/api/public/menu/${tokenOf(url)}`);
    const newRes = await rawCall(ctx.request, 'GET', `/api/public/menu/${tokenOf(url2)}`);
    check('o QR Code antigo deixa de funcionar (404) e o novo funciona (200)', oldRes.status === 404 && newRes.status === 200, `${oldRes.status}/${newRes.status}`);
    const stale = await ctx.newPage();
    await stale.goto(url);
    await stale.waitForSelector('text=QR Code inválido', { timeout: 8000 });
    check('quem abre o QR Code antigo vê "QR Code inválido"', true);
    await stale.close();
    await page.locator('.qr-frame').screenshot({ path: screenPng });
    check('o QR Code novo, lido pelo OpenCV, dá o endereço novo', decodeQr(screenPng) === url2, decodeQr(screenPng));

    // 5) folhas impressas: o que sai da impressora lê-se e dá exatamente os endereços das mesas ativas
    if (!pdfRasterizerAvailable()) {
      skip('leitura das folhas impressas', 'precisa do pdftoppm (pacote poppler-utils)');
    } else {
      await page.keyboard.press('Escape');
      await page.goto(`${BASE}/gerente/mesas/imprimir`);
      await page.waitForSelector('.qr-card');
      const active = (await apiTables()).filter((t) => t.active).sort((a, b) => a.table_number - b.table_number);
      check('a pré-visualização tem um cartão por mesa ativa', (await page.locator('.qr-card').count()) === active.length, `${await page.locator('.qr-card').count()} / ${active.length}`);
      await shot(page, 'gerente-3-folha-de-qr', { fullPage: true });
      await page.emulateMedia({ media: 'print' });
      const pdf = join(OUT, 'folha-qr.pdf');
      await page.pdf({ path: pdf, format: 'A4', preferCSSPageSize: true, printBackground: true });
      for (const f of readdirSync(OUT).filter((f) => /^folha-qr-\d+\.png$/.test(f))) rmSync(join(OUT, f));
      execFileSync('pdftoppm', ['-r', '200', '-png', pdf, join(OUT, 'folha-qr')]);
      const sheets = readdirSync(OUT).filter((f) => /^folha-qr-\d+\.png$/.test(f)).sort();
      const read = sheets.flatMap((f) => decodeQrSheet(join(OUT, f)));
      const expected = active.map((t) => t.qr_url);
      check('as folhas A4 impressas dão, lidas com o OpenCV, exatamente os endereços das mesas ativas (por ordem)', JSON.stringify(read) === JSON.stringify(expected), `${read.length} lidos / ${expected.length} esperados`);
      check('o número de folhas é o certo (6 cartões por folha)', sheets.length === Math.ceil(active.length / 6), `${sheets.length} folhas para ${active.length} mesas`);
      await page.emulateMedia({ media: 'screen' });
    }

    check('sem erros nos ecrãs', problems.length === 0, problems.join(' | '));
    await Promise.all([ctx.close(), cctx.close()]);
  });
}
