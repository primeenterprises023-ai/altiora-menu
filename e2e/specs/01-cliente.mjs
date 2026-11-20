// Cliente: do QR Code ao pedido, acompanhamento sem conta, erros claros e ecrã de telemóvel.
import { BASE, PHONE, SMALL_PHONE, check, feeOf, kz, newKey, noHorizontalScroll, placeOrder, publicMenu, publicOrder, rawCall, scenario, shot, watch } from '../lib.mjs';

export async function run(env) {
  const { browser, tables } = env;

  await scenario('Cliente: do QR Code ao pedido, no telemóvel', async () => {
    const problems = [];
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    watch(page, problems);
    const table = tables.get(2);
    const menu = await publicMenu(ctx.request, table.token);
    const price = (name) => menu.items[name].price_cents;
    const extra = (name, option) => menu.items[name].options.find((o) => o.name === option).price_delta_cents;

    await page.goto(table.url);
    await page.waitForSelector('.mn-card');
    const text = await page.locator('body').innerText();
    check('o endereço do QR Code abre o menu do restaurante, na mesa certa', text.includes(menu.restaurant.name) && /Mesa 2\b/i.test(text), text.slice(0, 120).replace(/\s+/g, ' '));
    check('o menu cabe no ecrã do telemóvel, sem deslocação lateral', await noHorizontalScroll(page));
    await shot(page, 'cliente-1-menu');

    // um prato simples (com "+"), um com extra e nota, e uma bebida com duas unidades
    await page.getByRole('button', { name: 'Adicionar Pastéis de bacalhau' }).click();
    await page.getByRole('button', { name: /^Muamba de galinha/ }).click();
    await page.waitForSelector('.sheet');
    await page.getByText('Funge extra').click();
    await page.getByLabel('Nota para a cozinha (opcional)').fill('Sem gindungo, por favor');
    await shot(page, 'cliente-2-prato');
    await page.getByRole('button', { name: /Adicionar ao pedido/ }).click();
    await page.getByRole('button', { name: 'Bebidas', exact: true }).click();
    await page.getByRole('button', { name: 'Adicionar Cerveja Cuca' }).click();
    await page.getByRole('button', { name: 'Aumentar Cerveja Cuca' }).click();
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    await page.waitForSelector('.comanda');

    const subtotal = price('Pastéis de bacalhau') + price('Muamba de galinha') + extra('Muamba de galinha', 'Funge extra') + 2 * price('Cerveja Cuca');
    const total = subtotal + feeOf(subtotal, menu.restaurant.service_fee_bps);
    const cart = (await page.locator('.sheet').innerText()).replace(/\s+/g, ' ');
    check('o pedido mostra os pratos, o extra, a nota e o total certo (com a taxa de serviço)', cart.includes('Funge extra') && cart.includes('Sem gindungo, por favor') && cart.includes(kz(total)), cart.slice(0, 300));
    await shot(page, 'cliente-3-pedido');

    await page.getByRole('button', { name: /Enviar pedido/ }).click();
    await page.waitForURL(/\/pedido\//);
    await page.waitForSelector('.order-ticket');
    const code = new URL(page.url()).pathname.split('/pedido/')[1];
    check('o link de acompanhamento tem um código longo e impossível de adivinhar', /^[A-Za-z0-9_-]{16,}$/.test(code), code);

    const order = await publicOrder(ctx.request, code);
    check('o pedido ficou gravado no servidor como "novo"', order && order.status === 'novo', JSON.stringify(order)?.slice(0, 200));
    check('o total gravado é o calculado pelo servidor a partir dos preços do menu', order && order.total_cents === total, `${order?.total_cents} ≠ ${total}`);
    const ticket = (await page.locator('.order-ticket').innerText()).replace(/\s+/g, ' ');
    check('a página do pedido mostra número, "Pedido recebido", linhas e total', new RegExp(`Pedido nº\\s*${order.order_number}\\b`).test(ticket) && ticket.includes('Pedido recebido') && ticket.includes('2× Cerveja Cuca') && ticket.includes(kz(total)), ticket.slice(0, 300));
    check('a página do pedido cabe no ecrã do telemóvel', await noHorizontalScroll(page));
    await shot(page, 'cliente-4-acompanhar');

    // acompanhamento sem conta: outro aparelho (sem cookies) abre o mesmo link
    const other = await browser.newContext(PHONE);
    const p2 = await other.newPage();
    watch(p2, problems);
    await p2.goto(`${BASE}/pedido/${code}`);
    await p2.waitForSelector('.order-ticket');
    check('o link de acompanhamento funciona noutro aparelho, sem conta nem sessão', new RegExp(`Pedido nº\\s*${order.order_number}\\b`).test((await p2.locator('.order-ticket').innerText()).replace(/\s+/g, ' ')));

    // histórico da mesa
    await page.getByRole('link', { name: 'Ver todos os pedidos da mesa' }).click();
    await page.waitForSelector('.history');
    check('o histórico da mesa lista o pedido feito', new RegExp(`\\b${order.order_number}\\b`).test(await page.locator('.history').innerText()));
    await shot(page, 'cliente-5-historico');

    // outra mesa não vê os pedidos desta
    const t3 = tables.get(3);
    const hist3 = await rawCall(other.request, 'GET', `/api/public/menu/${t3.token}/orders`);
    check('os pedidos de uma mesa não aparecem noutra mesa', hist3.status === 200 && !JSON.stringify(hist3.json).includes(code), JSON.stringify(hist3.json).slice(0, 200));

    check('sem erros no ecrã do cliente', problems.length === 0, problems.join(' | '));
    await ctx.close();
    await other.close();
  });

  await scenario('Erros claros: QR Code inválido, pedido inexistente e pedidos mal formados', async () => {
    const problems = [];
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    watch(page, problems);

    for (const [label, token] of [['com formato certo mas inexistente', 'a'.repeat(22)], ['com formato errado', 'curto']]) {
      await page.goto(`${BASE}/menu/${token}`);
      await page.waitForSelector('text=QR Code inválido');
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      check(`QR Code ${label}: mensagem simples em português, sem detalhes técnicos`, /Este QR Code não é válido ou foi desativado/.test(body) && !/undefined|\[object|Traceback|stack|SELECT|TABLE_NOT_FOUND/i.test(body), body.slice(0, 200));
    }
    await shot(page, 'erro-qr-invalido');

    await page.goto(`${BASE}/pedido/${'b'.repeat(22)}`);
    await page.waitForSelector('text=/não encontrado|não foi encontrado/i');
    check('link de pedido inexistente: mensagem clara', true);

    const t = tables.get(2);
    const menu = await publicMenu(ctx.request, t.token);
    const line = { menu_item_id: menu.items['Cerveja Cuca'].id, quantity: 1 };
    const post = (body, headers = { 'idempotency-key': newKey() }) => rawCall(ctx.request, 'POST', `/api/public/menu/${t.token}/orders`, body, headers);
    const shape = (r) => r.json && r.json.error && typeof r.json.error.code === 'string' && typeof r.json.error.message === 'string' && r.json.error.message.length > 3;

    const noKey = await post({ items: [line] }, {});
    check('pedido sem Idempotency-Key é recusado (400) com erro legível', noKey.status === 400 && noKey.json?.error?.code === 'IDEMPOTENCY_KEY_REQUIRED' && shape(noKey), noKey.text.slice(0, 200));
    const price = await post({ items: [{ ...line, unit_price_cents: 1 }] });
    check('o cliente não pode enviar preços: campo desconhecido recusado (400)', price.status === 400 && shape(price), `${price.status} ${price.text.slice(0, 150)}`);
    const total = await post({ items: [line], total_cents: 1 });
    check('o cliente não pode enviar o total: campo desconhecido recusado (400)', total.status === 400 && shape(total), `${total.status} ${total.text.slice(0, 150)}`);
    const zero = await post({ items: [{ ...line, quantity: 0 }] });
    check('quantidade zero é recusada', zero.status === 400 && shape(zero), `${zero.status}`);
    const huge = await post({ items: [{ ...line, quantity: 1000 }] });
    check('quantidade exagerada é recusada', huge.status === 400 && shape(huge), `${huge.status}`);
    const empty = await post({ items: [] });
    check('pedido sem pratos é recusado', empty.status === 400 && shape(empty), `${empty.status}`);
    const unknown = await post({ items: [{ menu_item_id: '00000000-0000-4000-8000-000000000000', quantity: 1 }] });
    check('prato inexistente é recusado com erro legível (4xx)', unknown.status >= 400 && unknown.status < 500 && shape(unknown), `${unknown.status} ${unknown.text.slice(0, 150)}`);
    const nul = await post({ items: [line], notes: 'olá\u0000mundo' });
    check('texto com caracteres inválidos não provoca erro do servidor', nul.status < 500, `${nul.status}`);
    const badJson = await rawCall(ctx.request, 'POST', `/api/public/menu/${t.token}/orders`, undefined, { 'idempotency-key': newKey() });
    check('pedido sem corpo é recusado, nunca erro 500', badJson.status >= 400 && badJson.status < 500, `${badJson.status}`);
    const none = await rawCall(ctx.request, 'GET', '/api/isto-nao-existe');
    check('rota inexistente devolve 404 em JSON com código e mensagem', none.status === 404 && shape(none), none.text.slice(0, 120));

    check('sem erros inesperados no ecrã', problems.length === 0, problems.join(' | '));
    await ctx.close();
  });

  await scenario('Telemóvel pequeno (360 px): ecrãs do cliente sem deslocação lateral e com botões grandes', async () => {
    const problems = [];
    const ctx = await browser.newContext(SMALL_PHONE);
    const page = await ctx.newPage();
    watch(page, problems);
    const t = tables.get(4);
    await page.goto(t.url);
    await page.waitForSelector('.mn-card');
    check('menu em 360 px sem deslocação lateral', await noHorizontalScroll(page));
    await page.getByRole('button', { name: 'Adicionar Pastéis de bacalhau' }).click();
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    await page.waitForSelector('.comanda');
    check('pedido em 360 px sem deslocação lateral', await noHorizontalScroll(page));
    const send = await page.getByRole('button', { name: /Enviar pedido/ }).boundingBox();
    check('o botão "Enviar pedido" é grande (pelo menos 48 px de altura e 280 px de largura)', send && send.height >= 48 && send.width >= 280, JSON.stringify(send));
    await shot(page, 'cliente-6-telemovel-pequeno');
    await page.getByRole('button', { name: /Enviar pedido/ }).click();
    await page.waitForSelector('.order-ticket');
    check('página do pedido em 360 px sem deslocação lateral', await noHorizontalScroll(page));
    check('sem erros no telemóvel pequeno', problems.length === 0, problems.join(' | '));
    await ctx.close();
  });
}
