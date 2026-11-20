// «Chamar o garçom»: a única função extra do cliente (no site não há pagamentos). O cliente chama a partir da mesa dele (QR Code),
// o empregado vê a mesa no ecrã sem recarregar e atende, e o cliente vê que foi atendido. Também: duplo toque, cancelar,
// quem pode ver as chamadas, o botão não tapar a barra do pedido, e a demonstração (sem mesas) não mostrar o botão.
import { BASE, PHONE, check, loginPage, noHorizontalScroll, rawCall, scenario, shot, until, watch } from '../lib.mjs';

const visible = (locator) => async () => locator.isVisible();
const openCalls = async (staff) => (await staff.call('GET', '/api/staff/waiter-calls')).json?.calls ?? [];
const toastText = async (page) => (await page.locator('.toasts').innerText()).replace(/\s+/g, ' ').trim();

const overlap = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export async function run(env) {
  const { browser, tables, waiter, manager, kitchen } = env;
  const table = tables.get(4);

  await scenario('Chamar o garçom: o cliente chama, o empregado vê e atende sem recarregar, e o cliente é avisado', async () => {
    const problems = [];
    const cctx = await browser.newContext(PHONE);
    const wctx = await browser.newContext(PHONE);
    const [cp, wp] = await Promise.all([cctx.newPage(), wctx.newPage()]);
    watch(cp, problems);
    watch(wp, problems);

    await loginPage(wp, 'empregado@terraza.demo');
    check('o empregado mostra "Em tempo real"', await until(visible(wp.locator('.pill-live').first()), { timeout: 10000 }));
    check('sem chamadas, o ecrã do empregado não mostra o aviso de mesas a chamar', (await wp.locator('section.calls').count()) === 0);

    await cp.goto(table.url);
    await cp.waitForSelector('.mn-card', { timeout: 15000 });
    const callBtn = cp.getByRole('button', { name: 'Chamar o garçom' });
    check('o cardápio da mesa tem o botão «Chamar o garçom»', await until(visible(callBtn), { timeout: 8000 }));
    const menuText = await cp.locator('body').innerText();
    check(
      'nada de pagamentos no cardápio da mesa (só pedir e chamar o garçom)',
      (await cp.getByRole('button', { name: /pagar|pagamento|multicaixa|cart[aã]o|mb way/i }).count()) === 0 && !/multicaixa|refer[eê]ncia de pagamento|pagar online|mb way/i.test(menuText),
    );
    check('no telemóvel não há deslocação na horizontal', await noHorizontalScroll(cp));

    // com o pedido em curso, o botão não pode ficar por cima da barra «Ver pedido»
    // (um prato simples, sem tamanhos nem extras, e com descrição comprida; o primeiro prato do menu é editado por outros ensaios)
    await cp.getByRole('button', { name: 'Adicionar Camarão ao alho' }).click();
    await cp.waitForSelector('.cart-bar', { timeout: 10000 });
    await cp.waitForTimeout(400);
    const boxes = { call: await callBtn.boundingBox(), bar: await cp.locator('.cart-bar').boundingBox() };
    check('com a barra «Ver pedido» no ecrã, o botão do garçom não fica por cima dela', !!boxes.call && !!boxes.bar && !overlap(boxes.call, boxes.bar), JSON.stringify(boxes));
    const dish = cp.locator('.mn-card', { hasText: 'Camarão ao alho' });
    // (o preço conta pelo texto que mostra, não pela caixa, que ocupa a largura toda da coluna)
    const priceText = await dish.locator('.mn-card-price').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    });
    const parts = { step: await dish.locator('.mn-step').boundingBox(), desc: await dish.locator('.mn-card-desc').boundingBox(), price: priceText };
    check('no prato já pedido, a barra «− 1 +» não fica por cima da descrição nem do preço', !!parts.step && !!parts.desc && !!parts.price && !overlap(parts.step, parts.desc) && !overlap(parts.step, parts.price), JSON.stringify(parts));
    await shot(cp, 'garcom-0-cliente-com-pedido');

    await callBtn.click();
    const sheet = cp.locator('.sheet');
    await sheet.waitFor({ state: 'visible', timeout: 5000 });
    check('o cliente é perguntado antes de chamar, com o número da mesa', /Mesa 4/i.test(await sheet.innerText()) && (await sheet.getByRole('button', { name: 'Chamar agora' }).isVisible()));
    await cp.waitForTimeout(700); // deixa a folha acabar de subir antes de fotografar
    await shot(cp, 'garcom-1-cliente-confirmar');

    await sheet.getByRole('button', { name: 'Chamar agora' }).click();
    check('o cliente vê a confirmação «Chamámos o garçom»', await until(async () => /Chamámos o garçom\. Já vem a caminho\./.test(await toastText(cp)), { timeout: 8000 }), await toastText(cp));
    check('o botão passa a dizer «Garçom chamado»', await until(visible(cp.getByRole('button', { name: 'Garçom chamado' })), { timeout: 8000 }));
    await until(async () => (await toastText(cp)) === '', { timeout: 6000 }); // o aviso passa e o botão fica à vista
    await shot(cp, 'garcom-2-cliente-chamado');

    // o empregado vê a mesa no ecrã, sem recarregar
    const banner = wp.locator('section.calls');
    const shown = await until(visible(banner), { timeout: 10000 });
    const bannerText = shown ? await banner.innerText() : '';
    check('o empregado vê o aviso «1 mesa a chamar», sem recarregar', shown && /1 mesa a chamar/.test(bannerText), bannerText);
    check('o aviso diz qual é a mesa e há quanto tempo espera', /Mesa 4/.test(bannerText) && /(agora|há|min|s\b)/i.test(bannerText), bannerText);
    check('o título da página do empregado avisa da chamada', await until(async () => /^\(\d+\) Sala/.test(await wp.title()), { timeout: 5000 }), await wp.title());
    await shot(wp, 'garcom-3-empregado-aviso');

    await wp.getByRole('tab', { name: /^Mesas/ }).click();
    const tile = wp.locator('.table-tile.has-call');
    const tileOk = await until(visible(tile), { timeout: 5000 });
    check('no separador «Mesas», a mesa 4 aparece marcada «A chamar o garçom»', tileOk && /A chamar o garçom/.test(await tile.innerText()) && ((await tile.getAttribute('aria-label')) ?? '').startsWith('Mesa 4'));
    await shot(wp, 'garcom-4-empregado-mesas');

    // duplo toque, ou outro telemóvel na mesma mesa: continua a haver uma só chamada
    const again = await rawCall(cctx.request, 'POST', `/api/public/menu/${table.token}/call-waiter`);
    const calls1 = (await openCalls(waiter)).filter((c) => c.table_number === 4);
    check('chamar outra vez da mesma mesa não cria outra chamada (continua só uma)', again.status === 200 && calls1.length === 1 && again.json?.call?.id === calls1[0].id, `${again.status} · ${calls1.length}`);

    // quem vê as chamadas: o empregado e o gerente; a cozinha não
    check('o gerente também vê a chamada (200)', ((await manager.call('GET', '/api/staff/waiter-calls')).json?.calls ?? []).some((c) => c.table_number === 4));
    check('a cozinha não tem acesso às chamadas (403)', (await kitchen.call('GET', '/api/staff/waiter-calls')).status === 403);

    // o empregado atende
    await wp.getByRole('tab', { name: /^A entregar/ }).click();
    await banner.getByRole('button', { name: /Atender a Mesa 4/ }).click();
    check('ao atender, a chamada sai do ecrã do empregado', await until(async () => (await wp.locator('section.calls').count()) === 0, { timeout: 8000 }));
    check('o servidor guarda a chamada como atendida (já não está em aberto)', (await openCalls(waiter)).filter((c) => c.table_number === 4).length === 0);
    check('o cliente é avisado «O garçom atendeu a sua chamada», sem recarregar', await until(async () => /O garçom atendeu a sua chamada\./.test(await toastText(cp)), { timeout: 20000 }), await toastText(cp));
    check('e o botão volta a «Chamar o garçom»', await until(visible(cp.getByRole('button', { name: 'Chamar o garçom' })), { timeout: 5000 }));
    await shot(cp, 'garcom-5-cliente-atendido');
    const twice = await waiter.call('POST', `/api/staff/waiter-calls/${calls1[0].id}/attend`);
    check('atender outra vez a mesma chamada é recusado com clareza (409)', twice.status === 409 && twice.json?.error?.code === 'CALL_ALREADY_DONE', `${twice.status} ${twice.text.slice(0, 120)}`);

    // o cliente muda de ideias e cancela
    await until(async () => (await toastText(cp)) === '', { timeout: 6000 });
    await cp.getByRole('button', { name: 'Chamar o garçom' }).click();
    await cp.locator('.sheet').getByRole('button', { name: 'Chamar agora' }).click();
    check('o empregado volta a ver a mesa a chamar', await until(visible(wp.locator('section.calls')), { timeout: 10000 }));
    await until(async () => (await toastText(cp)) === '', { timeout: 6000 });
    await cp.getByRole('button', { name: 'Garçom chamado' }).click();
    const sheet2 = cp.locator('.sheet');
    await sheet2.waitFor({ state: 'visible', timeout: 5000 });
    check('com a chamada em aberto, o cliente só pode cancelá-la (não cria outra)', (await sheet2.getByRole('button', { name: 'Cancelar a chamada' }).isVisible()) && (await sheet2.getByRole('button', { name: 'Chamar agora' }).count()) === 0);
    await cp.waitForTimeout(700);
    await shot(cp, 'garcom-6-cliente-cancelar');
    await sheet2.getByRole('button', { name: 'Cancelar a chamada' }).click();
    check('ao cancelar, o aviso desaparece do ecrã do empregado, sem recarregar', await until(async () => (await wp.locator('section.calls').count()) === 0, { timeout: 10000 }));
    await cp.waitForTimeout(1200);
    check('o cliente não recebe «o garçom atendeu» por uma chamada que ele próprio cancelou', !/atendeu/.test(await toastText(cp)), await toastText(cp));
    check('e o botão volta a «Chamar o garçom»', await until(visible(cp.getByRole('button', { name: 'Chamar o garçom' })), { timeout: 5000 }));
    check('não ficou nenhuma chamada em aberto', (await openCalls(waiter)).length === 0);

    check('sem erros nos dois ecrãs', problems.length === 0, problems.join(' | '));
    await Promise.all([cctx.close(), wctx.close()]);
  });

  await scenario('Chamar o garçom: o gerente também vê a chamada no ecrã dele e pode atendê-la', async () => {
    const problems = [];
    const mctx = await browser.newContext({ locale: 'pt-AO', timezoneId: 'Africa/Luanda', viewport: { width: 1280, height: 800 } });
    const cctx = await browser.newContext();
    const mp = await mctx.newPage();
    watch(mp, problems);
    await loginPage(mp, 'gerente@terraza.demo');
    await mp.goto(`${BASE}/gerente`);
    await mp.waitForSelector('main', { timeout: 10000 });
    check('antes da chamada, o ecrã de pedidos do gerente não mostra o aviso', (await mp.locator('section.calls').count()) === 0);

    const t5 = tables.get(5);
    const made = await rawCall(cctx.request, 'POST', `/api/public/menu/${t5.token}/call-waiter`);
    check('o cliente da mesa 5 chama o garçom (201)', made.status === 201, `${made.status} ${made.text.slice(0, 100)}`);
    const banner = mp.locator('section.calls');
    const shown = await until(visible(banner), { timeout: 12000 });
    check('o gerente vê «Mesa 5» a chamar, sem recarregar', shown && /Mesa 5/.test(await banner.innerText()), shown ? await banner.innerText() : 'sem aviso');
    await shot(mp, 'garcom-7-gerente-aviso');
    await banner.getByRole('button', { name: /Atender a Mesa 5/ }).click();
    check('o gerente atende e o aviso desaparece', await until(async () => (await mp.locator('section.calls').count()) === 0, { timeout: 8000 }));
    check('não ficou nenhuma chamada em aberto', (await openCalls(waiter)).length === 0);
    check('sem erros no ecrã do gerente', problems.length === 0, problems.join(' | '));
    await Promise.all([mctx.close(), cctx.close()]);
  });

  await scenario('Chamar o garçom: o cardápio de demonstração (sem mesas) não mostra o botão nem aceita chamadas', async () => {
    const problems = [];
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    watch(page, problems);
    const pub = await rawCall(ctx.request, 'GET', '/api/public/restaurants/demo');
    check('a API do cardápio de demonstração diz que não aceita chamadas ao garçom', pub.status === 200 && pub.json?.capabilities?.waiter_call === false, `${pub.status} ${JSON.stringify(pub.json?.capabilities)}`);
    const slug = pub.json?.restaurant?.slug ?? 'demo';
    await page.goto(`${BASE}/r/${slug}`, { waitUntil: 'networkidle' });
    check('o cardápio de demonstração não tem o botão «Chamar o garçom»', (await page.getByRole('button', { name: /garçom/i }).count()) === 0);
    await ctx.close();
  });
}
