// ALTIORA MENU: a página comercial, o cardápio público do restaurante de demonstração (Casa Aurora), o painel do gerente
// (perfil, fotografias, modelo 3D, plano) e o painel da Altiora (planos, restaurantes, contactos), usados como as pessoas os usam.
//
// O 3D precisa de WebGL: abre-se um Chromium próprio, com renderização por software. Se mesmo assim não houver WebGL,
// as verificações do 3D ficam como «saltadas» e o resumo diz porquê (o produto, nesse caso, mostra a fotografia).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BASE, OUT, PHONE, check, loginPage, noHorizontalScroll, publicMenu, rawCall, scenario, shot, skip, until, watch } from '../lib.mjs';

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'demo-media', 'assets');
const DESKTOP = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: 'pt-AO', timezoneId: 'Africa/Luanda', colorScheme: 'light' };
const WEBGL_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * Toca num botão no meio do ecrã. O clique automático do Playwright, nesta página (com barras fixas em cima e em baixo), por vezes
 * alinha o botão com uma borda e diz que «outro elemento recebe o clique»; a pessoa, ao deslizar o dedo, vê o botão e toca nele.
 * Aqui faz-se o mesmo: centra o botão no ecrã e toca nas coordenadas dele.
 */
async function tapInMiddle(page, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  const box = await locator.boundingBox();
  if (!box) throw new Error('o botão não está visível');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Regista respostas de erro do servidor (5xx) e pedidos que falharam, para que um ecrã com um ficheiro em falta não passe em branco. */
function watchRequests(page, bucket) {
  page.on('response', (r) => {
    if (r.status() >= 500) bucket.push(`resposta ${r.status()}: ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    if (!/net::ERR_ABORTED/.test(r.failure()?.errorText ?? '')) bucket.push(`pedido falhado: ${r.url()} ${r.failure()?.errorText}`);
  });
}

export async function run(env) {
  const { browser, manager, platform, tables } = env;
  const gl = await chromium.launch({ args: WEBGL_ARGS });
  try {
    const probe = await gl.newPage();
    const webgl = await probe.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    await probe.close();
    if (!webgl) skip('WebGL disponível neste Chromium', 'sem WebGL as verificações do modelo 3D ficam saltadas');

    // -----------------------------------------------------------------------------------------------
    await scenario('Página comercial: conteúdo, planos, cardápio de exemplo, 3D, perguntas e pedido de contacto', async () => {
      const problems = [];
      const ctx = await gl.newContext(DESKTOP);
      const page = await ctx.newPage();
      watch(page, problems);
      watchRequests(page, problems);
      const res = await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      check('a página comercial abre em / (200)', res?.status() === 200, String(res?.status()));
      check('o título da página tem ALTIORA MENU', /ALTIORA MENU/.test(await page.title()), await page.title());
      const h1 = await page.locator('h1').first().innerText();
      check('o título principal fala do QR Code e do 3D', /QR Code/.test(h1) && /3D/.test(h1), h1);
      const sections = ['como-funciona', 'cardapio', 'modelo-3d', 'beneficios', 'funcionalidades', 'planos', 'demonstracao', 'perguntas', 'contacto'];
      const missing = [];
      for (const id of sections) if ((await page.locator(`#${id}`).count()) !== 1) missing.push(id);
      check('as 9 secções da página existem (como funciona, cardápio, 3D, benefícios, funcionalidades, planos, demonstração, perguntas, contacto)', missing.length === 0, missing.join(', '));

      // planos: sem preços inventados (o preço vem da Altiora; enquanto não está definido diz «sob consulta»)
      const planCards = await page.locator('#planos .lp-plan').allInnerTexts();
      check('há 3 planos (Starter, Pro, Premium)', planCards.length === 3 && ['Starter', 'Pro', 'Premium'].every((n) => planCards.some((t) => t.includes(n))), planCards.map((t) => t.slice(0, 20)).join(' | '));
      check('cada plano mostra o seu preço definido ou «sob consulta», nunca um valor inventado', planCards.every((t) => /sob consulta/i.test(t) || /\d\s*Kz/.test(t)), planCards.join(' | ').slice(0, 200));

      // cardápio de exemplo, vindo do restaurante de demonstração
      const dishes = await page.locator('#cardapio .lp-dish').count();
      check('o cardápio de exemplo mostra pratos da Casa Aurora', dishes >= 6, String(dishes));
      check('os pratos de exemplo dizem que são exemplos (nada de preços a fingir que são reais)', /exemplo|demonstra/i.test(await page.locator('#cardapio').innerText()));
      const chips = page.locator('#cardapio .lp-chip');
      if ((await chips.count()) > 1) {
        const before = await page.locator('#cardapio .lp-dish:visible').count();
        await chips.nth(1).click();
        const after = await page.locator('#cardapio .lp-dish:visible').count();
        check('o filtro por categoria esconde os pratos das outras categorias', after > 0 && after < before, `${before} → ${after}`);
        await chips.first().click();
        check('«Todos» volta a mostrar tudo', (await page.locator('#cardapio .lp-dish:visible').count()) === before);
      }

      // 3D a sério (modelo GLB do prato) e demonstração interativa
      if (webgl) {
        const open = page.locator('#modelo-3d .lp-3d-open');
        await open.waitFor({ state: 'visible', timeout: 10000 });
        await open.click();
        const canvas = await until(async () => (await page.locator('#modelo-3d canvas').count()) > 0, { timeout: 25000 });
        check('«Ver em 3D» na página comercial abre o modelo (canvas WebGL)', !!canvas);
        await shot(page, 'altiora-menu-1-comercial-3d', { fullPage: false });
      }
      const iframe = await page.locator('#demonstracao iframe').getAttribute('src');
      check('a demonstração incorpora o cardápio de exemplo em /r/<restaurante>', /^\/r\/[a-z0-9-]+\?embed=1/.test(iframe ?? ''), iframe ?? 'sem iframe');

      // perguntas frequentes
      const faq = page.locator('#perguntas details.lp-faq-item');
      check('há perguntas frequentes', (await faq.count()) >= 5);
      await faq.first().locator('summary').click();
      check('abrir uma pergunta mostra a resposta', await faq.first().evaluate((d) => d.open));

      // marca e empresa
      const text = await page.locator('body').innerText();
      check('a marca e a assinatura aparecem (ALTIORA MENU, Digital Dining Experience, Altiora Grupo)', /ALTIORA\s+MENU/.test(text) && /Digital Dining Experience/.test(text) && /Altiora Grupo/.test(text));
      check('sem a grafia «Altiora Group» (o nome em português é Altiora Grupo)', !/Altiora Group\b/.test(text));

      // pedido de contacto: erros, depois sucesso
      const leadsBefore = (await platform.call('GET', '/api/admin/leads')).json.leads.length;
      await page.locator('#lp-form button[type=submit]').scrollIntoViewIfNeeded();
      await page.locator('#lp-form button[type=submit]').click();
      await page.waitForSelector('#lp-form .lp-err:not(:empty)', { state: 'attached', timeout: 5000 });
      check('enviar o formulário vazio mostra o que falta e não envia nada', (await platform.call('GET', '/api/admin/leads')).json.leads.length === leadsBefore);
      const business = `Restaurante E2E ${Date.now().toString(36)}`;
      await page.locator('#f-name').fill('Ana Ensaio');
      await page.locator('#f-business').fill(business);
      await page.locator('#f-email').fill('ana.ensaio@example.com');
      await page.locator('#f-plan').selectOption({ index: 1 });
      await page.locator('#f-message').fill('Queremos o menu 3D.\nPodem ligar à tarde?');
      await page.locator('#lp-form button[type=submit]').click();
      await page.waitForSelector('#e-consent:not(:empty)', { state: 'attached', timeout: 5000 });
      check('sem consentimento o pedido não é enviado (e o formulário diz porquê)', (await platform.call('GET', '/api/admin/leads')).json.leads.length === leadsBefore);
      await page.locator('#f-consent').check();
      await page.locator('#lp-form button[type=submit]').click();
      await page.locator('#lp-sent').waitFor({ state: 'visible', timeout: 8000 });
      const lead = await until(async () => (await platform.call('GET', '/api/admin/leads')).json.leads.find((l) => l.business === business), { timeout: 5000 });
      check('o pedido de contacto chega à Altiora (painel de contactos)', !!lead && lead.email === 'ana.ensaio@example.com', JSON.stringify(lead));
      await shot(page, 'altiora-menu-2-comercial-contacto');
      check('a página comercial não teve erros nem pedidos falhados', problems.length === 0, problems.join(' | '));
      await ctx.close();

      // telemóvel
      const pctx = await gl.newContext(PHONE);
      const phone = await pctx.newPage();
      const pproblems = [];
      watch(phone, pproblems);
      watchRequests(phone, pproblems);
      await phone.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      check('no telemóvel não há deslocação na horizontal', await noHorizontalScroll(phone));
      await shot(phone, 'altiora-menu-3-comercial-telemovel', { fullPage: true });
      check('a página comercial no telemóvel não teve erros', pproblems.length === 0, pproblems.join(' | '));
      await pctx.close();
    });

    // -----------------------------------------------------------------------------------------------
    await scenario('Aviso de privacidade: abre, e todas as ligações internas levam a algum sítio', async () => {
      const ctx = await browser.newContext(DESKTOP);
      const page = await ctx.newPage();
      const res = await page.goto(`${BASE}/privacidade`, { waitUntil: 'networkidle' });
      check('/privacidade abre (200) com o título certo', res?.status() === 200 && /Como tratamos os seus dados/.test(await page.locator('h1').innerText()));
      const home = await ctx.newPage();
      await home.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      const homeIds = new Set(await home.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id)));
      const ownIds = new Set(await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id)));
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
      const dead = hrefs.filter((h) => (h.startsWith('/#') ? !homeIds.has(h.slice(2)) : h.startsWith('#') ? !ownIds.has(h.slice(1)) : false));
      check('nenhuma âncora (#…) aponta para um sítio que não existe', dead.length === 0, dead.join(', '));
      const text = await page.locator('body').innerText();
      check('o aviso não promete o que não pode (nada de «100% seguro», «conforme à lei X» ou «nunca» absolutos)', !/100\s*%|totalmente seguro|à prova de|garantimos que nunca/i.test(text));
      await ctx.close();
    });

    // -----------------------------------------------------------------------------------------------
    await scenario('Cardápio público da Casa Aurora (demonstração) no telemóvel: identidade, pesquisa, prato, 3D', async () => {
      const problems = [];
      const ctx = await gl.newContext(PHONE);
      const page = await ctx.newPage();
      watch(page, problems);
      watchRequests(page, problems);
      const slug = (await (await rawCall(ctx.request, 'GET', '/api/public/restaurants/demo')).json)?.restaurant?.slug ?? 'demo';
      await page.goto(`${BASE}/r/${slug}`, { waitUntil: 'networkidle' });
      check('o título é «Casa Aurora — Cardápio digital»', (await page.title()) === 'Casa Aurora — Cardápio digital', await page.title());
      check('diz que é um cardápio de demonstração com pratos fictícios', await page.getByText('Cardápio de demonstração', { exact: false }).first().isVisible());
      check('mostra o estado do horário («abre hoje às…» ou «aberto»)', /Aberto|Fechado/.test(await page.locator('body').innerText()));
      check('no telemóvel não há deslocação na horizontal', await noHorizontalScroll(page));
      await shot(page, 'altiora-menu-4-cardapio-topo');

      await page.getByPlaceholder('Pesquisar pratos e ingredientes').fill('camar');
      await page.waitForTimeout(400);
      check('a pesquisa «camar» encontra o camarão e esconde o resto', (await page.getByRole('button', { name: /Camarão tigre grelhado/ }).count()) > 0 && (await page.getByRole('button', { name: /Costeleta de vaca/ }).count()) === 0);
      await shot(page, 'altiora-menu-5-cardapio-pesquisa');
      await page.getByPlaceholder('Pesquisar pratos e ingredientes').fill('');

      await page.getByRole('button', { name: /^Muamba de galinha/ }).first().click();
      const sheet = page.locator('.sheet');
      await sheet.getByText('Ingredientes').first().waitFor({ timeout: 8000 });
      const sheetText = await sheet.innerText();
      check('o prato mostra preço em Kz, ingredientes e tamanhos', /Kz/.test(sheetText) && /ingredientes/i.test(sheetText) && /tamanho/i.test(sheetText));
      check('sem pagamentos no site: o cliente não vê meios de pagamento (só chamar o garçom, se houver mesa)', !/multicaixa|cartão|pagar|referência de pagamento/i.test(sheetText));
      check('em computador não aparece «Ver na minha mesa» (só em telemóveis compatíveis)', (await page.getByRole('button', { name: 'Ver na minha mesa' }).count()) === 0);
      if (webgl) {
        await page.getByRole('button', { name: 'Ver em 3D' }).click();
        const canvas = await until(async () => (await page.locator('.sheet canvas').count()) > 0, { timeout: 25000 });
        check('«Ver em 3D» abre o modelo verdadeiro do prato (canvas)', !!canvas);
        await page.waitForTimeout(2500);
        await shot(page, 'altiora-menu-6-cardapio-prato-3d');
      } else {
        skip('«Ver em 3D» no cardápio', 'sem WebGL neste Chromium');
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      await page.getByRole('button', { name: /^Costeleta de vaca/ }).first().click();
      await page.locator('.sheet').getByText('Ingredientes').first().waitFor({ timeout: 8000 });
      check('um prato sem modelo 3D mostra só a fotografia (sem «Ver em 3D» inventado)', (await page.getByRole('button', { name: 'Ver em 3D' }).count()) === 0);
      await shot(page, 'altiora-menu-7-cardapio-prato-sem-3d');
      check('o cardápio não teve erros nem pedidos falhados', problems.length === 0, problems.join(' | '));
      await ctx.close();
    });

    // -----------------------------------------------------------------------------------------------
    await scenario('Gerente: plano, logótipo e capa, contactos, horário, fotografia e modelo 3D do prato, tamanhos, PDF do QR', async () => {
      const problems = [];
      const ctx = await gl.newContext({ ...PHONE, acceptDownloads: true });
      const page = await ctx.newPage();
      watch(page, problems);
      watchRequests(page, problems);
      await loginPage(page, 'gerente@terraza.demo');

      // plano
      await page.goto(`${BASE}/gerente/plano`);
      await page.waitForSelector('.feature');
      const planText = await page.locator('body').innerText();
      check('a página do plano mostra o plano Premium e o que inclui', /Premium/.test(planText) && (await page.locator('.feature.is-on').count()) >= 5);
      check('o gerente não paga nem muda o plano aqui: diz que é a Altiora que o muda', /pela Altiora Grupo/.test(planText));
      await shot(page, 'altiora-menu-8-gerente-plano', { fullPage: true });

      // definições
      await page.goto(`${BASE}/gerente/definicoes`);
      await page.waitForSelector('text=Dados do restaurante');
      const srcOf = async (sel) => ((await page.locator(sel).count()) ? await page.locator(sel).first().getAttribute('src') : null);
      const changed = (sel, old) => page.waitForFunction(([s, o]) => { const e = document.querySelector(s); return e && e.getAttribute('src') !== o; }, [sel, old], { timeout: 60000 });
      const oldLogo = await srcOf('.upload-logo .upload-preview');
      await page.locator('input[type=file]').nth(0).setInputFiles(join(MEDIA, 'logo.png'));
      await changed('.upload-logo .upload-preview', oldLogo);
      const oldCover = await srcOf('.upload-cover .upload-preview');
      await page.locator('input[type=file]').nth(1).setInputFiles(join(MEDIA, 'cover.jpg'));
      await changed('.upload-cover .upload-preview', oldCover);
      const notImage = join(OUT, 'nao-imagem.jpg');
      writeFileSync(notImage, 'isto não é uma fotografia, só texto com a extensão .jpg');
      await page.locator('input[type=file]').nth(1).setInputFiles(notImage);
      check('um ficheiro que não é imagem (mesmo com .jpg) é recusado com uma frase clara', !!(await until(async () => (await page.locator('.field-error').count()) > 0, { timeout: 8000 })));
      await page.getByLabel('Email (opcional)').fill('geral@terraza.demo');
      await page.getByLabel('WhatsApp para pedidos (opcional)').fill('+244 923 111 222');
      await page.getByLabel('Localização no mapa (opcional)').fill('https://maps.google.com/?q=Terraza+Talatona');
      // o horário pode já ter dias abertos (aí o botão de segunda-feira diz «+ Horário»): abre segunda se estiver fechada e copia-a para a semana
      const monday = page.locator('.hours-day').first();
      if ((await monday.getByRole('button', { name: 'Abrir' }).count()) > 0) await monday.getByRole('button', { name: 'Abrir' }).click();
      await tapInMiddle(page, page.getByRole('button', { name: /^Copiar .* para todos os dias$/ }));
      await page.getByRole('button', { name: 'Guardar alterações' }).click();
      await page.waitForSelector('text=Definições guardadas.', { timeout: 8000 });
      const saved = (await manager.call('GET', '/api/restaurants/current')).json.restaurant;
      const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      check('logótipo, capa, contactos e horário (7 dias) ficaram guardados', /^\/a\//.test(saved.logo_url ?? '') && /^\/a\//.test(saved.cover_url ?? '') && saved.email === 'geral@terraza.demo' && weekdays.every((d) => (saved.opening_hours?.[d]?.length ?? 0) > 0), JSON.stringify({ l: saved.logo_url, c: saved.cover_url, e: saved.email, h: saved.opening_hours }));
      const publicPage = await rawCall(ctx.request, 'GET', '/api/public/restaurants/terraza-talatona');
      check('o cardápio público do restaurante já usa o logótipo e a capa novos', publicPage.json?.restaurant?.logo_url === saved.logo_url && publicPage.json?.restaurant?.cover_url === saved.cover_url);
      await shot(page, 'altiora-menu-9-gerente-definicoes', { fullPage: true });

      // prato: fotografia, ingredientes, alergénios, modelo 3D
      await page.goto(`${BASE}/gerente/menu`);
      await page.waitForSelector('.adm-row');
      const dishName = (await page.locator('.adm-row .adm-row-main').first().getAttribute('aria-label')).replace(/^Abrir /, '');
      await page.locator('.adm-row button:has-text("Editar")').first().click();
      await page.waitForSelector('text=Editar prato');
      await page.waitForTimeout(600);
      const sheet = page.locator('.sheet');
      const oldPhoto = (await sheet.locator('.upload-preview').count()) ? await sheet.locator('.upload-preview').first().getAttribute('src') : null;
      await sheet.locator('input[type=file]').nth(0).setInputFiles(join(MEDIA, 'muamba.jpg'));
      await page.waitForFunction((o) => { const e = document.querySelector('.sheet .upload-preview'); return e && e.getAttribute('src') !== o; }, oldPhoto, { timeout: 60000 });
      await sheet.getByLabel('Ingredientes (opcional)').fill('galinha, óleo de palma ,  quiabo, galinha, alho');
      await sheet.getByLabel('Glúten').check();
      await sheet.getByLabel('Leite').check();
      await sheet.locator('input[type=file]').nth(1).setInputFiles(join(MEDIA, 'cafe.glb'));
      await sheet.locator('text=Modelo 3D definido').waitFor({ timeout: 15000 });
      if (webgl) {
        await sheet.getByRole('button', { name: 'Pré-visualizar' }).click();
        const canvas = await until(async () => (await page.locator('canvas').count()) > 0, { timeout: 25000 });
        check('«Pré-visualizar» mostra o modelo 3D carregado, antes de guardar', !!canvas);
        await page.waitForTimeout(1500);
        await shot(page, 'altiora-menu-10-gerente-previsualizar-3d');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
      // um modelo que não é GLB é recusado
      const notModel = join(OUT, 'nao-modelo.glb');
      writeFileSync(notModel, 'isto não é um modelo 3D');
      await sheet.locator('input[type=file]').nth(1).setInputFiles(notModel);
      check('um ficheiro que não é um modelo GLB é recusado com uma frase clara', !!(await until(async () => (await sheet.locator('.field-error').count()) > 0, { timeout: 8000 })));
      await sheet.getByRole('button', { name: 'Guardar', exact: true }).click();
      await page.waitForSelector('text=Prato guardado.', { timeout: 10000 });
      const menu = (await manager.call('GET', '/api/menu')).json;
      const item = menu.categories.flatMap((c) => c.items).find((i) => i.name === dishName);
      check('o prato ficou com fotografia, miniatura e modelo 3D guardados', /^\/a\//.test(item.image_url ?? '') && /^\/a\//.test(item.thumb_url ?? '') && /^\/a\//.test(item.model_url ?? ''), JSON.stringify([item.image_url, item.thumb_url, item.model_url]));
      check('ingredientes limpos (sem repetidos nem espaços a mais) e 2 alergénios', JSON.stringify(item.ingredients) === JSON.stringify(['galinha', 'óleo de palma', 'quiabo', 'alho']) && item.allergens.length === 2, JSON.stringify([item.ingredients, item.allergens]));
      const anon = await browser.newContext();
      const pub = await publicMenu(anon.request, tables.get(1).token);
      check('o cliente da mesa vê o modelo 3D do prato (o plano inclui 3D)', /^\/a\//.test(pub.items[dishName]?.model_url ?? ''), String(pub.items[dishName]?.model_url));
      const asset = await anon.request.get(`${BASE}${pub.items[dishName].model_url}`);
      check('o ficheiro do modelo é servido como model/gltf-binary e começa por «glTF»', asset.status() === 200 && /model\/gltf-binary/.test(asset.headers()['content-type'] ?? '') && (await asset.body()).subarray(0, 4).toString('latin1') === 'glTF');
      await anon.close();

      // tamanho
      await page.locator('.adm-row button:has-text("Editar")').first().click();
      await page.waitForSelector('text=Editar prato');
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'Adicionar tamanho' }).click();
      await page.waitForSelector('text=/Novo tamanho/');
      await page.waitForTimeout(400);
      await page.getByLabel('Nome do tamanho').fill('Meia dose');
      await page.getByLabel(/Acréscimo ao preço do prato/).fill('0');
      await page.getByRole('button', { name: 'Adicionar tamanho' }).last().click();
      await page.waitForSelector('text=Tamanho adicionado.', { timeout: 8000 });
      const menu2 = (await manager.call('GET', '/api/menu')).json;
      const options = menu2.categories.flatMap((c) => c.items).find((i) => i.name === dishName).options;
      check('o tamanho «Meia dose» ficou como tamanho (o cliente escolhe um)', options.some((o) => o.name === 'Meia dose' && o.kind === 'size'), JSON.stringify(options));
      await page.keyboard.press('Escape');

      // PDF do QR Code do restaurante
      await page.goto(`${BASE}/gerente/mesas`);
      await page.waitForSelector('text=QR Code do restaurante');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Descarregar PDF' }).first().click()]);
      const pdf = await (await import('node:fs/promises')).readFile(await download.path());
      check('o PDF do QR Code do restaurante descarrega e é um PDF', pdf.subarray(0, 5).toString('latin1') === '%PDF-', pdf.subarray(0, 8).toString('latin1'));
      await shot(page, 'altiora-menu-11-gerente-qr-restaurante');
      check('o painel do gerente não teve erros nem pedidos falhados', problems.length === 0, problems.join(' | '));
      await ctx.close();
    });

    // -----------------------------------------------------------------------------------------------
    await scenario('Altiora: números, planos e preços, novo restaurante, suspender e reativar, contactos', async () => {
      const problems = [];
      const ctx = await browser.newContext({ ...PHONE });
      const page = await ctx.newPage();
      watch(page, problems);
      watchRequests(page, problems);
      await loginPage(page, 'admin@altiora.demo');
      await page.waitForSelector('.kpi-grid');
      const cards = (await page.locator('.person-main').allInnerTexts()).join(' | ');
      check('a Altiora vê a lista de restaurantes (Terraza Talatona e Casa Aurora)', /Terraza Talatona/.test(cards) && /Casa Aurora/.test(cards));
      await shot(page, 'altiora-menu-12-plataforma-restaurantes', { fullPage: true });

      // planos e preços
      await page.getByRole('link', { name: 'Planos' }).click();
      await page.waitForSelector('.plan-card');
      const planNames = await page.locator('.plan-card-name').allInnerTexts();
      check('estão lá os 3 planos de origem (Starter, Pro, Premium)', ['Starter', 'Pro', 'Premium'].every((n) => planNames.some((t) => t.includes(n))), planNames.join(', '));
      await page.getByRole('button', { name: 'Novo plano' }).click();
      await page.getByRole('button', { name: 'Criar plano' }).click();
      check('um plano vazio é recusado com mensagens junto aos campos', (await page.locator('.field-error').count()) >= 2);
      await page.getByLabel('Código do plano').fill('ouro');
      await page.getByLabel('Nome', { exact: true }).fill('Ouro');
      await page.getByLabel('Frase curta').fill('Para grupos com vários restaurantes.');
      await page.getByLabel('Posição na lista').fill('4');
      await page.getByRole('checkbox', { name: /Realidade aumentada/ }).check();
      check('ligar a realidade aumentada liga também os pratos em 3D (um depende do outro)', await page.getByRole('checkbox', { name: /Pratos em 3D/ }).isChecked());
      await page.getByRole('checkbox', { name: /Pedidos digitais/ }).check();
      await page.getByLabel('Por mês').first().fill('75 000');
      await page.getByLabel('Por ano (opcional)').first().fill('abc');
      await page.getByRole('button', { name: 'Criar plano' }).click();
      await page.waitForSelector('text=Preço anual em AOA');
      await page.getByLabel('Por ano (opcional)').first().fill('750.000');
      await page.getByLabel('Acrescentar preço noutra moeda').selectOption('EUR');
      await page.getByLabel('Por mês').nth(1).fill('99,50');
      await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/admin/plans') && r.request().method() === 'POST'), page.getByRole('button', { name: 'Criar plano' }).click()]);
      await page.waitForSelector('text=Ouro');
      const plans = (await platform.call('GET', '/api/admin/plans')).json.plans;
      const ouro = plans.find((p) => p.code === 'ouro');
      const priceOf = (currency) => ouro?.prices?.find((p) => p.currency === currency);
      check('o plano Ouro ficou com as suas funcionalidades e os preços em AOA (75 000 / 750 000) e EUR (99,50)', !!ouro && ouro.features.includes('ar') && ouro.features.includes('model_3d') && priceOf('AOA')?.monthly_cents === 7500000 && priceOf('AOA')?.yearly_cents === 75000000 && priceOf('EUR')?.monthly_cents === 9950, JSON.stringify(ouro));
      await shot(page, 'altiora-menu-13-plataforma-planos', { fullPage: true });

      // novo restaurante com o plano Ouro e moeda EUR
      await page.getByRole('link', { name: 'Restaurantes' }).click();
      await page.waitForSelector('.kpi-grid');
      await page.getByRole('button', { name: 'Novo restaurante' }).click();
      await page.getByLabel('Nome do restaurante').fill('Casa Teste E2E');
      await page.getByLabel('Plano', { exact: true }).selectOption('ouro');
      await page.getByLabel('Moeda dos preços do menu').selectOption('EUR');
      await page.getByLabel('Nome do gerente').fill('Teresa Teste');
      await page.getByLabel('E-mail do gerente').fill('teste.e2e@casa.example');
      await page.getByRole('button', { name: 'Criar restaurante' }).click();
      await page.waitForSelector('text=Restaurante criado');
      const tempPassword = await page.locator('.cred').first().innerText().catch(() => '');
      check('o restaurante novo nasce com a conta do gerente e uma palavra-passe temporária mostrada uma vez', /teste\.e2e@casa\.example/.test(tempPassword), tempPassword.slice(0, 120));
      await page.getByRole('button', { name: 'Concluir' }).click();
      const restaurants = (await platform.call('GET', '/api/admin/restaurants')).json.restaurants;
      const created = restaurants.find((r) => r.name === 'Casa Teste E2E');
      check('o restaurante Casa Teste E2E existe com o plano Ouro e moeda EUR', !!created && created.plan_code === 'ouro' && created.currency === 'EUR', JSON.stringify(created));
      const slug = created?.slug;

      // suspender e reativar
      await page.getByRole('button', { name: /Gerir Casa Teste E2E/ }).first().click();
      await page.waitForSelector('text=Assinatura');
      await page.getByLabel('Estado', { exact: true }).selectOption('suspenso');
      await page.getByRole('button', { name: 'Guardar alterações' }).click();
      await page.getByRole('button', { name: /^Suspender Casa Teste E2E/ }).click(); // pede confirmação antes de suspender
      await page.waitForSelector('text=Casa Teste E2E ficou suspenso.', { timeout: 8000 });
      const suspended = await rawCall(ctx.request, 'GET', `/api/public/restaurants/${slug}`);
      check('um restaurante suspenso deixa de estar disponível para os clientes (403)', suspended.status === 403, String(suspended.status));
      await page.getByRole('button', { name: /Gerir Casa Teste E2E/ }).first().click();
      await page.waitForSelector('text=Assinatura');
      await page.getByLabel('Estado', { exact: true }).selectOption('ativo');
      await page.getByRole('button', { name: 'Guardar alterações' }).click();
      await page.waitForSelector('text=Alterações guardadas.', { timeout: 8000 });
      const back = await until(async () => (await rawCall(ctx.request, 'GET', `/api/public/restaurants/${slug}`)).status === 200, { timeout: 5000 });
      check('reativado, o cardápio volta a abrir (200)', !!back);

      // contactos
      await page.getByRole('link', { name: /Contactos/ }).click();
      await page.waitForSelector('.lead-card');
      const before = await page.locator('.lead-card').count();
      await page.getByRole('button', { name: 'Marcar como contactado' }).first().click();
      await page.waitForFunction((n) => document.querySelectorAll('.lead-card').length === n - 1, before, { timeout: 8000 });
      check('marcar um contacto como contactado tira-o da lista de novos', (await page.locator('.lead-card').count()) === before - 1);
      await page.getByRole('button', { name: /^Contactados/ }).click();
      const done = await page.locator('.lead-card').count();
      await page.getByRole('button', { name: 'Apagar' }).first().click();
      await page.getByRole('button', { name: 'Apagar contacto' }).click();
      await page.waitForSelector('text=Contacto apagado.', { timeout: 8000 });
      check('apagar um contacto remove-o', (await page.locator('.lead-card').count()) === done - 1);
      await shot(page, 'altiora-menu-14-plataforma-contactos');
      check('o painel da Altiora não teve erros nem pedidos falhados', problems.length === 0, problems.join(' | '));
      await ctx.close();
    });
  } finally {
    await gl.close();
  }
}

