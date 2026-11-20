// Casos-limite: prato esgotado a meio do pedido, duplo toque, resposta perdida e pedidos pausados.
import { PHONE, activeOrders, check, loginPage, noHorizontalScroll, placeOrder, publicOrder, scenario, shot, sleep, until, watch } from '../lib.mjs';

const mark = (name) => `e2e-${name}-${Math.random().toString(36).slice(2, 8)}`;

async function menuItem(manager, name) {
  const cats = (await manager.call('GET', '/api/menu')).json.categories;
  for (const c of cats) for (const i of c.items) if (i.name === name) return i;
  throw new Error(`prato não encontrado: ${name}`);
}

export async function run(env) {
  const { browser, tables, manager, waiter } = env;

  // -------------------------------------------------------------------------------------------------
  await scenario('Prato esgotado a meio do pedido: a cozinha marca, o cliente é avisado e nada é aceite por engano', async () => {
    const problems = [];
    const table = tables.get(6);
    const kctx = await browser.newContext(PHONE);
    const cctx = await browser.newContext(PHONE);
    const [kp, cp] = await Promise.all([kctx.newPage(), cctx.newPage()]);
    watch(kp, problems);
    watch(cp, problems);
    try {
      await loginPage(kp, 'cozinha@terraza.demo');
      await cp.goto(table.url);
      await cp.waitForSelector('.mn-card');
      // o cliente escolhe dois pratos e ainda pensa em enviar
      await cp.getByRole('button', { name: 'Adicionar Mandioca frita' }).click();
      await cp.getByRole('button', { name: 'Adicionar Água mineral 0,5 l' }).click();

      // entretanto a cozinha fica sem mandioca e marca-a como esgotada, no ecrã da cozinha
      await kp.getByRole('button', { name: /^Esgotados/ }).click();
      await kp.waitForSelector('.stock-row');
      await kp.getByRole('switch', { name: /Mandioca frita/ }).first().click();
      check('a cozinha marca "Mandioca frita" como esgotada e o servidor regista-o', await until(async () => (await menuItem(manager, 'Mandioca frita')).available === false, { timeout: 8000 }));
      await shot(kp, 'cozinha-5-esgotados');

      const before = (await activeOrders(manager, table.id)).length;
      await cp.getByRole('button', { name: /Ver pedido/ }).click();
      await cp.waitForSelector('.comanda');
      await cp.getByRole('button', { name: /Enviar pedido/ }).click();
      check('ao enviar, o cliente é avisado de que o menu mudou', await until(async () => /O menu mudou/.test(await cp.locator('.sheet').innerText()), { timeout: 10000 }), (await cp.locator('.sheet').innerText()).slice(0, 200));
      check('nenhum pedido foi criado por engano', (await activeOrders(manager, table.id)).length === before);
      check('o prato esgotado sai do pedido, com um aviso claro', await until(async () => /Mandioca frita.{0,6} esgotou e foi retirado do pedido/.test((await cp.locator('body').innerText()).replace(/\s+/g, ' ')), { timeout: 10000 }));
      await shot(cp, 'cliente-9-prato-esgotado');

      // a API também recusa (409), com mensagem legível
      const direct = await placeOrder(cctx.request, table.token, [{ name: 'Mandioca frita', qty: 1 }]);
      check('pelo servidor, pedir o prato esgotado é recusado (409 ITEM_UNAVAILABLE)', direct.status === 409 && direct.json?.error?.code === 'ITEM_UNAVAILABLE', `${direct.status} ${direct.text?.slice(0, 120)}`);

      // no menu, o prato aparece como esgotado e não se pode pedir
      await cp.keyboard.press('Escape');
      const dish = cp.locator('.mn-card', { hasText: 'Mandioca frita' }).first();
      check('no menu, "Mandioca frita" aparece como "Esgotado" e não tem botão para a pedir', /esgotado/i.test(await dish.innerText()) && (await dish.getByRole('button', { name: /^Adicionar / }).count()) === 0);
      // abrir o prato esgotado mostra o aviso, mas não deixa adicioná-lo ao pedido
      await dish.getByRole('button', { name: /^Mandioca frita/ }).click();
      await cp.waitForSelector('.sheet');
      const soldOutSheet = await cp.locator('.sheet').innerText();
      check('o detalhe do prato esgotado avisa que está esgotado e não deixa adicioná-lo', /Este prato está esgotado de momento/.test(soldOutSheet) && (await cp.getByRole('button', { name: /Adicionar ao pedido/ }).count()) === 0, soldOutSheet.slice(0, 160));
      await cp.keyboard.press('Escape');
      await cp.waitForSelector('.sheet', { state: 'detached' });

      // o resto do pedido segue normalmente
      await cp.getByRole('button', { name: /Ver pedido/ }).click();
      await cp.waitForSelector('.comanda');
      await cp.getByRole('button', { name: /Enviar pedido/ }).click();
      await cp.waitForURL(/\/pedido\//, { timeout: 10000 });
      const code = new URL(cp.url()).pathname.split('/pedido/')[1];
      const order = await publicOrder(cctx.request, code);
      check('o pedido que seguiu só tem a água (sem o prato esgotado)', order.items.length === 1 && order.items[0].name === 'Água mineral 0,5 l', JSON.stringify(order.items.map((i) => i.name)));
    } finally {
      // deixa o menu como estava
      const item = await menuItem(manager, 'Mandioca frita');
      if (!item.available) await manager.call('PATCH', `/api/menu/items/${item.id}/availability`, { available: true });
    }
    check('o prato voltou a estar disponível (limpeza)', (await menuItem(manager, 'Mandioca frita')).available === true);
    check('sem erros inesperados nos ecrãs', problems.length === 0, problems.join(' | '));
    await Promise.all([kctx.close(), cctx.close()]);
  });

  // -------------------------------------------------------------------------------------------------
  await scenario('Duplo toque em "Enviar pedido" (com a rede lenta): só nasce um pedido', async () => {
    const problems = [];
    const table = tables.get(7);
    const note = mark('duplo');
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    watch(page, problems);
    let posts = 0;
    await page.route('**/api/public/menu/*/orders', async (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        await sleep(800); // rede lenta: dá tempo para o segundo toque
      }
      await route.continue();
    });
    await page.goto(table.url);
    await page.waitForSelector('.mn-card');
    await page.getByRole('button', { name: 'Adicionar Água mineral 0,5 l' }).click();
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    await page.waitForSelector('.comanda');
    await page.getByLabel('Alguma indicação para o pedido? (opcional)').fill(note);
    await page.getByRole('button', { name: /Enviar pedido/ }).dblclick();
    await page.waitForURL(/\/pedido\//, { timeout: 15000 });
    await sleep(500);
    const mine = (await activeOrders(manager, table.id)).filter((o) => (o.notes ?? '').includes(note));
    check('apesar do duplo toque, só existe um pedido', mine.length === 1, `${mine.length} pedidos`);
    check('o ecrã enviou o pedido uma só vez (o botão ficou bloqueado enquanto enviava)', posts === 1, `${posts} envios`);
    check('sem erros inesperados', problems.length === 0, problems.join(' | '));
    await ctx.close();
  });

  // -------------------------------------------------------------------------------------------------
  await scenario('Resposta perdida: o servidor gravou o pedido mas o telemóvel não soube; tocar de novo não duplica', async () => {
    const problems = [];
    const table = tables.get(8);
    const note = mark('perdida');
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    watch(page, problems, { network: true });
    const keys = [];
    let attempt = 0;
    await page.route('**/api/public/menu/*/orders', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempt++;
      keys.push(route.request().headers()['idempotency-key']);
      if (attempt === 1) {
        await route.fetch(); // o servidor recebe e grava…
        await route.abort('failed'); // …mas a resposta nunca chega ao telemóvel
      } else {
        await route.continue();
      }
    });
    await page.goto(table.url);
    await page.waitForSelector('.mn-card');
    await page.getByRole('button', { name: 'Adicionar Água mineral 0,5 l' }).click();
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    await page.waitForSelector('.comanda');
    await page.getByLabel('Alguma indicação para o pedido? (opcional)').fill(note);
    await page.getByRole('button', { name: /Enviar pedido/ }).click();
    check('sem resposta, o cliente vê "O pedido ainda não foi confirmado" (e não uma mensagem de sucesso falsa)', await until(async () => /O pedido ainda não foi confirmado/.test(await page.locator('.sheet').innerText()), { timeout: 10000 }));
    await shot(page, 'cliente-10-resposta-perdida');
    const created = (await activeOrders(manager, table.id)).filter((o) => (o.notes ?? '').includes(note));
    check('o pedido tinha, de facto, ficado gravado no servidor', created.length === 1, `${created.length}`);

    await page.getByRole('button', { name: /Enviar pedido/ }).click();
    await page.waitForURL(/\/pedido\//, { timeout: 10000 });
    const code = new URL(page.url()).pathname.split('/pedido/')[1];
    const after = (await activeOrders(manager, table.id)).filter((o) => (o.notes ?? '').includes(note));
    const shown = await publicOrder(ctx.request, code);
    check('ao tocar de novo, o cliente recebe o mesmo pedido e não nasce um segundo', after.length === 1 && shown?.order_number === after[0].order_number, `${after.length} pedidos; o cliente vê o nº ${shown?.order_number}, o servidor tem o nº ${after[0]?.order_number}`);
    check('o telemóvel reutilizou a mesma chave de repetição', keys.length === 2 && keys[0] && keys[0] === keys[1], JSON.stringify(keys));
    check('sem erros inesperados (fora o erro de rede provocado)', problems.length === 0, problems.join(' | '));
    await ctx.close();
  });

  // -------------------------------------------------------------------------------------------------
  await scenario('Pedidos por QR Code pausados: o cliente é avisado, o servidor recusa e o empregado continua a poder registar', async () => {
    const problems = [];
    const table = tables.get(3);
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    watch(page, problems);
    try {
      const paused = await manager.call('PATCH', '/api/restaurants/current', { accepting_orders: false });
      check('o gerente pausa os pedidos por QR Code (200)', paused.status === 200, `${paused.status} ${paused.text.slice(0, 100)}`);
      await page.goto(table.url);
      await page.waitForSelector('.mn-card');
      check('o cliente vê o aviso de que o restaurante não está a receber pedidos por QR Code', await page.getByText('O restaurante não está a receber pedidos por QR Code neste momento.').isVisible());
      check('não há botões para adicionar pratos nem barra de envio', (await page.getByRole('button', { name: /^Adicionar / }).count()) === 0 && (await page.getByRole('button', { name: /Ver pedido/ }).count()) === 0);
      check('o menu pausado cabe no ecrã', await noHorizontalScroll(page));
      await shot(page, 'cliente-11-pausado');
      const direct = await placeOrder(ctx.request, table.token, [{ name: 'Água mineral 0,5 l', qty: 1 }]);
      check('o servidor recusa pedidos por QR Code enquanto estiver pausado (409 NOT_ACCEPTING_ORDERS)', direct.status === 409 && direct.json?.error?.code === 'NOT_ACCEPTING_ORDERS', `${direct.status} ${direct.text.slice(0, 120)}`);
      const item = await menuItem(manager, 'Água mineral 0,5 l');
      const manual = await waiter.call('POST', '/api/orders', { table_id: table.id, items: [{ menu_item_id: item.id, quantity: 1 }] });
      check('o empregado continua a poder registar pedidos presenciais (201)', manual.status === 201, `${manual.status} ${manual.text.slice(0, 120)}`);
    } finally {
      await manager.call('PATCH', '/api/restaurants/current', { accepting_orders: true });
    }
    await page.reload();
    await page.waitForSelector('.mn-card');
    check('ao retomar, o aviso desaparece e voltam os botões de pedir', (await page.getByText('O restaurante não está a receber pedidos por QR Code neste momento.').count()) === 0 && (await page.getByRole('button', { name: /^Adicionar /, includeHidden: false }).count()) > 0);
    check('sem erros inesperados', problems.length === 0, problems.join(' | '));
    await ctx.close();
  });
}
