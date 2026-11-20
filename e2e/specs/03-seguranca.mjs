// Segurança: texto malicioso nas notas, permissões de cada perfil e isolamento entre restaurantes.
import { BASE, PHONE, activeOrders, apiAs, check, loginPage, newKey, placeOrder, publicMenu, publicOrder, rawCall, scenario, shot, trapDialogs, until, watch } from '../lib.mjs';

const mark = (name) => `e2e-${name}-${Math.random().toString(36).slice(2, 8)}`;
const status = (name, res, expected) => check(name, Array.isArray(expected) ? expected.includes(res.status) : res.status === expected, `${res.status} ${res.text.slice(0, 120)}`);

export async function run(env) {
  const { browser, tables, manager, kitchen, waiter, platform } = env;

  // -------------------------------------------------------------------------------------------------
  await scenario('Texto malicioso nas notas: aparece como texto, nunca executa', async () => {
    const problems = [];
    const dialogs = [];
    const id = mark('xss');
    const dishNote = '<img src=x onerror="window.__xss=1">';
    const orderNote = `${id} <script>window.__xss=2</script> "><svg onload=window.__xss=3> javascript:alert(1)`;

    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    watch(page, problems);
    trapDialogs(page, dialogs);

    // o cliente escreve as notas no ecrã, como qualquer pessoa
    await page.goto(tables.get(1).url);
    await page.waitForSelector('.mn-card');
    await page.getByRole('button', { name: /^Salada de tomate e cebola/ }).click();
    await page.waitForSelector('.sheet');
    await page.getByLabel('Nota para a cozinha (opcional)').fill(dishNote);
    await page.getByRole('button', { name: /Adicionar ao pedido/ }).click();
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    await page.waitForSelector('.comanda');
    await page.getByLabel('Alguma indicação para o pedido? (opcional)').fill(orderNote);
    await page.getByRole('button', { name: /Enviar pedido/ }).click();
    await page.waitForURL(/\/pedido\//);
    await page.waitForSelector('.order-ticket');
    const code = new URL(page.url()).pathname.split('/pedido/')[1];

    const noInjection = async (p, label) => {
      const flag = await p.evaluate(() => window.__xss);
      const imgs = await p.locator('img[src="x"], svg[onload]').count();
      check(`${label}: nada foi executado (sem diálogos, sem marcas no navegador, sem elementos injetados)`, flag === undefined && imgs === 0 && dialogs.length === 0, `flag=${flag} elementos=${imgs} diálogos=${dialogs.join('|')}`);
    };
    const ticket = await page.locator('.order-ticket').innerText();
    check('página do cliente: as notas aparecem como texto, tal como foram escritas', ticket.includes(dishNote) && ticket.includes('<script>window.__xss=2</script>'), ticket.slice(0, 200));
    await noInjection(page, 'página do cliente');
    const stored = await publicOrder(ctx.request, code);
    check('o servidor guardou o texto tal como foi escrito (sem o alterar nem o executar)', stored.notes === orderNote && stored.items[0].notes === dishNote, JSON.stringify([stored.notes, stored.items[0].notes]));

    // cozinha, empregado e gerente veem o mesmo pedido nos seus ecrãs
    for (const [who, email, route, label] of [
      ['cozinha', 'cozinha@terraza.demo', '/cozinha', 'cozinha'],
      ['empregado', 'empregado@terraza.demo', '/empregado', 'empregado'],
      ['gerente', 'gerente@terraza.demo', '/gerente', 'gerente'],
    ]) {
      const sctx = await browser.newContext(PHONE);
      const sp = await sctx.newPage();
      watch(sp, problems);
      trapDialogs(sp, dialogs);
      await loginPage(sp, email);
      if (who === 'empregado') await sp.getByRole('tab', { name: /Em curso/ }).click();
      const c = sp.locator('.order-card', { hasText: id }).first();
      const found = await until(async () => c.isVisible(), { timeout: 10000 });
      check(`${label}: o pedido aparece na lista`, found);
      if (found) {
        const text = await c.innerText();
        check(`${label}: as notas aparecem como texto`, text.includes('<script>window.__xss=2</script>') && text.includes(dishNote), text.slice(0, 200));
        await c.getByRole('button', { name: /Detalhes|Ver/ }).first().click().catch(() => undefined);
        await sp.waitForTimeout(500);
        if (who === 'cozinha') await shot(sp, 'seguranca-1-texto-malicioso-cozinha');
      }
      await noInjection(sp, label);
      await sctx.close();
    }

    // o histórico da mesa (cliente)
    await page.goto(`${BASE}/menu/${tables.get(1).token}`);
    await page.waitForSelector('.mn-card');
    await noInjection(page, 'menu do cliente');
    check('sem erros nos ecrãs', problems.length === 0, problems.join(' | '));
    await ctx.close();
  });

  // -------------------------------------------------------------------------------------------------
  await scenario('Permissões: cada perfil só faz o que lhe cabe', async () => {
    const anon = await browser.newContext();
    const noAuth = (path) => rawCall(anon.request, 'GET', path);
    status('sem sessão, a lista de pedidos é recusada (401)', await noAuth('/api/orders'), 401);
    status('sem sessão, as mesas são recusadas (401)', await noAuth('/api/tables'), 401);
    status('sem sessão, a área da plataforma é recusada (401)', await noAuth('/api/admin/restaurants'), 401);

    // um pedido novo para testar transições
    const placed = await placeOrder(anon.request, tables.get(2).token, [{ name: 'Mandioca frita', qty: 1 }], mark('perm'));
    const order = (await activeOrders(manager)).find((o) => o.order_number === placed.order.order_number);
    const item = (await manager.call('GET', '/api/menu')).json.categories[0].items[0];

    // cozinha
    status('cozinha: não cria categorias do menu (403)', await kitchen.call('POST', '/api/menu/categories', { name: 'Intrusa' }), 403);
    status('cozinha: não altera as definições do restaurante (403)', await kitchen.call('PATCH', '/api/restaurants/current', { name: 'Outro nome' }), 403);
    status('cozinha: não vê relatórios (403)', await kitchen.call('GET', '/api/reports/sales'), 403);
    status('cozinha: não vê a equipa (403)', await kitchen.call('GET', '/api/staff'), 403);
    status('cozinha: não cria mesas (403)', await kitchen.call('POST', '/api/tables', { table_number: 99 }), 403);
    status('cozinha: não regista pedidos presenciais (403)', await kitchen.call('POST', '/api/orders', { table_id: tables.get(2).id, items: [{ menu_item_id: item.id, quantity: 1 }] }), 403);
    status('cozinha: não regista pagamentos (403)', await kitchen.call('POST', `/api/orders/${order.id}/payments`, { method: 'dinheiro', amount_cents: 100 }), 403);
    status('cozinha: não confirma entregas (403)', await kitchen.call('POST', `/api/order-status/${order.id}`, { to: 'entregue' }), [403, 409]);
    status('cozinha: pode marcar um prato como esgotado e voltar a disponível (200)', await kitchen.call('PATCH', `/api/menu/items/${item.id}/availability`, { available: true }), 200);

    // empregado
    status('empregado: não vê relatórios (403)', await waiter.call('GET', '/api/reports/sales'), 403);
    status('empregado: não vê a equipa (403)', await waiter.call('GET', '/api/staff'), 403);
    status('empregado: não cria pratos (403)', await waiter.call('POST', '/api/menu/items', { name: 'Intruso' }), 403);
    status('empregado: não gera novos QR Codes (403)', await waiter.call('POST', `/api/tables/${tables.get(2).id}/regenerate-qr`), 403);
    status('empregado: não marca pratos como esgotados (403)', await waiter.call('PATCH', `/api/menu/items/${item.id}/availability`, { available: false }), 403);
    status('empregado: não inicia a preparação (403)', await waiter.call('POST', `/api/order-status/${order.id}`, { to: 'em_preparacao' }), [403, 409]);
    const manual = await waiter.call('POST', '/api/orders', { table_id: tables.get(2).id, items: [{ menu_item_id: item.id, quantity: 1 }] });
    status('empregado: regista um pedido presencial (201)', manual, 201);

    // gerente
    status('gerente: vê os relatórios (200)', await manager.call('GET', '/api/reports/sales'), [200, 400]);
    status('gerente: vê a equipa (200)', await manager.call('GET', '/api/staff'), 200);

    // plataforma: não vê dados dos restaurantes
    status('plataforma: não vê pedidos dos restaurantes (403)', await platform.call('GET', '/api/orders'), [403, 404]);
    status('plataforma: não vê menus dos restaurantes (403)', await platform.call('GET', '/api/menu'), [403, 404]);
    status('plataforma: não vê mesas dos restaurantes (403)', await platform.call('GET', '/api/tables'), [403, 404]);
    status('plataforma: não vê a equipa dos restaurantes (403)', await platform.call('GET', '/api/staff'), [403, 404]);
    status('gerente: não entra na área da plataforma (403)', await manager.call('GET', '/api/admin/restaurants'), 403);

    // ecrãs: quem não tem permissão é levado para o seu ecrã
    const problems = [];
    const kctx = await browser.newContext(PHONE);
    const kp = await kctx.newPage();
    watch(kp, problems);
    await loginPage(kp, 'cozinha@terraza.demo');
    await kp.goto(`${BASE}/gerente/definicoes`);
    await kp.waitForURL((u) => !u.pathname.startsWith('/gerente'), { timeout: 8000 }).catch(() => undefined);
    check('cozinha que abre o endereço das definições é levada para o seu ecrã', new URL(kp.url()).pathname.startsWith('/cozinha'), kp.url());
    const wctx = await browser.newContext(PHONE);
    const wp = await wctx.newPage();
    watch(wp, problems);
    await loginPage(wp, 'empregado@terraza.demo');
    await wp.goto(`${BASE}/gerente/relatorios`);
    await wp.waitForURL((u) => !u.pathname.startsWith('/gerente'), { timeout: 8000 }).catch(() => undefined);
    check('empregado que abre o endereço dos relatórios é levado para o seu ecrã', new URL(wp.url()).pathname.startsWith('/empregado'), wp.url());
    check('sem erros inesperados nos ecrãs', problems.length === 0, problems.join(' | '));
    await Promise.all([anon.close(), kctx.close(), wctx.close()]);
  });

  // -------------------------------------------------------------------------------------------------
  await scenario('Isolamento entre restaurantes: o gerente de um não vê nem toca nos dados do outro', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `gerente-b-${suffix}@e2e.demo`;
    const created = await platform.call('POST', '/api/admin/restaurants', { name: `Restaurante E2E ${suffix}`, manager: { name: 'Gerente B', email } });
    status('a plataforma cria um segundo restaurante com o seu gerente (201)', created, 201);
    const temp = created.json.manager.temporary_password;

    // primeiro acesso: a palavra-passe temporária obriga a escolher outra
    const first = await apiAs(browser, email, temp);
    check('a palavra-passe temporária obriga a mudar antes de usar a conta', first.user.must_change_password === true);
    const blocked = await first.call('GET', '/api/orders');
    status('antes de mudar a palavra-passe, o resto da API fica bloqueado (403)', blocked, 403);
    const newPassword = `Nova-Palavra-${suffix}-2026`;
    status('o gerente escolhe a sua palavra-passe', await first.call('POST', '/api/auth/change-password', { current_password: temp, new_password: newPassword }), [200, 204]);
    const B = await apiAs(browser, email, newPassword);

    // as três mesas e o menu de A não existem para B
    const aOrders = await activeOrders(manager);
    check('o restaurante A tem pedidos em curso para este teste', aOrders.length > 0);
    const aOrder = aOrders[0];
    const aTable = tables.get(2);
    const aItem = (await manager.call('GET', '/api/menu')).json.categories[0].items[0];

    const bOrders = await B.call('GET', '/api/orders?scope=active');
    check('B não vê nenhum pedido de A (lista vazia)', bOrders.status === 200 && bOrders.json.orders.length === 0, bOrders.text.slice(0, 150));
    const bHistory = await B.call('GET', '/api/orders?scope=history');
    check('B não vê o histórico de A', bHistory.status === 200 && bHistory.json.orders.length === 0, bHistory.text.slice(0, 150));
    check('B não vê mesas de A', (await B.call('GET', '/api/tables')).json.tables.length === 0);
    check('B não vê o menu de A', (await B.call('GET', '/api/menu')).json.categories.length === 0);
    status('B não abre um pedido de A pelo número interno (404)', await B.call('GET', `/api/orders/${aOrder.id}`), 404);
    status('B não muda o estado de um pedido de A (404)', await B.call('POST', `/api/order-status/${aOrder.id}`, { to: 'em_preparacao' }), 404);
    status('B não vê os pagamentos de um pedido de A (404)', await B.call('GET', `/api/orders/${aOrder.id}/payments`), 404);
    status('B não altera uma mesa de A (404)', await B.call('PATCH', `/api/tables/${aTable.id}`, { label: 'roubada' }), 404);
    status('B não renova o QR Code de uma mesa de A (404)', await B.call('POST', `/api/tables/${aTable.id}/regenerate-qr`), 404);
    status('B não apaga uma mesa de A (404)', await B.call('DELETE', `/api/tables/${aTable.id}`), 404);
    status('B não altera um prato de A (404)', await B.call('PATCH', `/api/menu/items/${aItem.id}`, { name: 'roubado' }), 404);
    status('B não marca como esgotado um prato de A (404)', await B.call('PATCH', `/api/menu/items/${aItem.id}/availability`, { available: false }), 404);
    const mine = await B.call('GET', '/api/restaurants/current');
    check('B só vê o seu próprio restaurante', mine.json.restaurant.name === `Restaurante E2E ${suffix}`, mine.text.slice(0, 120));

    // B monta o seu restaurante; A não vê nada disto
    const bTable = await B.call('POST', '/api/tables', { table_number: 1, label: `SO-DE-B-${suffix}` });
    status('B cria a sua mesa 1 (201), mesmo existindo a mesa 1 em A', bTable, 201);
    const aTablesAfter = JSON.stringify((await manager.call('GET', '/api/tables')).json);
    check('A não vê a mesa de B', !aTablesAfter.includes(`SO-DE-B-${suffix}`));
    const bTables = (await B.call('GET', '/api/tables')).json.tables;
    const bToken = bTables.find((t) => t.label === `SO-DE-B-${suffix}`)?.qr_url?.split('/menu/')[1];
    check('B obtém o QR Code da sua mesa', Boolean(bToken));

    // os QR Codes de A continuam a abrir o menu de A, e só o de A
    const pub = await browser.newContext();
    const aPublic = await publicMenu(pub.request, aTable.token);
    check('o QR Code de A continua a abrir o menu de A', aPublic.restaurant.name === 'Terraza Talatona' && Object.keys(aPublic.items).length > 5);
    if (bToken) {
      const bPublic = await rawCall(pub.request, 'GET', `/api/public/menu/${bToken}`);
      check('o QR Code de B abre o restaurante de B (sem pratos de A)', bPublic.status === 200 && bPublic.json.restaurant.name === `Restaurante E2E ${suffix}` && bPublic.json.categories.length === 0, bPublic.text.slice(0, 150));
      // pedido com o prato de A pelo QR Code de B: tem de falhar
      const cross = await rawCall(pub.request, 'POST', `/api/public/menu/${bToken}/orders`, { items: [{ menu_item_id: aItem.id, quantity: 1 }] }, { 'idempotency-key': newKey() });
      check('pedir um prato de A pelo QR Code de B é recusado (4xx)', cross.status >= 400 && cross.status < 500, `${cross.status} ${cross.text.slice(0, 120)}`);
    }
    await pub.close();
  });
}
