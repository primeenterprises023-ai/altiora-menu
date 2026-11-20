// Tempo real: cozinha, empregado e cliente veem as mudanças sem recarregar; recuperação de quedas de rede;
// e o caso de o tempo real estar bloqueado (o ecrã passa a atualizar-se por consulta periódica).
import { BASE, PHONE, activeOrders, check, loginPage, placeOrder, publicOrder, scenario, shot, until, watch } from '../lib.mjs';

const mark = (name) => `e2e-${name}-${Math.random().toString(36).slice(2, 8)}`;
const card = (page, note) => page.locator('.order-card', { hasText: note }).first();
const visible = (locator) => async () => locator.isVisible();
const statusTitle = (page) => async () => (await page.locator('.order-status-title').innerText()).trim();
const statusIs = (page, text) => async () => (await statusTitle(page)()) === text;

export async function run(env) {
  const { browser, tables, kitchen } = env;

  await scenario('Tempo real: pedido novo → cozinha → pronto → entregue, sem recarregar nenhum ecrã', async () => {
    const problems = [];
    const kctx = await browser.newContext(PHONE);
    const wctx = await browser.newContext(PHONE);
    const cctx = await browser.newContext(PHONE);
    const [kp, wp, cp] = await Promise.all([kctx.newPage(), wctx.newPage(), cctx.newPage()]);
    for (const p of [kp, wp, cp]) watch(p, problems);

    await loginPage(kp, 'cozinha@terraza.demo');
    await loginPage(wp, 'empregado@terraza.demo');
    check('a cozinha mostra "Em tempo real"', await until(visible(kp.locator('.pill-live').first()), { timeout: 10000 }));
    check('o empregado mostra "Em tempo real"', await until(visible(wp.locator('.pill-live').first()), { timeout: 10000 }));

    // o cliente faz o pedido (pela API, para ser rápido; o caminho pelo ecrã já foi ensaiado) e acompanha-o no telemóvel
    const note = mark('rt');
    const placed = await placeOrder(cctx.request, tables.get(5).token, [{ name: 'Muamba de galinha', qty: 1 }, { name: 'Água mineral 0,5 l', qty: 2 }], note);
    check('o pedido do cliente é aceite (201)', placed.status === 201, `${placed.status} ${placed.text?.slice(0, 120)}`);
    const code = placed.order.public_code;
    await cp.goto(`${BASE}/pedido/${code}`);
    await cp.waitForSelector('.order-ticket');
    check('o cliente vê "Pedido recebido" e que o ecrã atualiza em tempo real', (await statusIs(cp, 'Pedido recebido')()) && (await until(async () => /em tempo real/.test(await cp.locator('.order-link-state').innerText()), { timeout: 8000 })));

    const kc = card(kp, note);
    check('a cozinha recebe o pedido novo sozinha, sem recarregar a página', await until(visible(kc), { timeout: 8000 }));
    check('o título da página da cozinha avisa dos pedidos novos', /^\(\d+\) Cozinha/.test(await kp.title()), await kp.title());
    await shot(kp, 'cozinha-1-pedido-novo');

    await kc.getByRole('button', { name: 'Iniciar preparação' }).click();
    check('o cliente passa a ver "Em preparação", sem recarregar', await until(statusIs(cp, 'Em preparação'), { timeout: 10000 }), await statusTitle(cp)());

    await kp.getByRole('tab', { name: /Em preparação/ }).click();
    const kc2 = card(kp, note);
    await kc2.waitFor({ state: 'visible', timeout: 8000 });
    await kc2.getByRole('button', { name: 'Marcar como pronto' }).click();
    check('o cliente passa a ver "Pronto, a caminho da sua mesa"', await until(statusIs(cp, 'Pronto, a caminho da sua mesa'), { timeout: 10000 }), await statusTitle(cp)());

    const wc = card(wp, note);
    check('o empregado vê o pedido pronto para entregar, sem recarregar', await until(visible(wc), { timeout: 8000 }));
    await shot(wp, 'empregado-1-entregar');
    await wc.getByRole('button', { name: 'Confirmar entrega' }).click();
    check('o cliente passa a ver "Entregue"', await until(statusIs(cp, 'Entregue'), { timeout: 10000 }), await statusTitle(cp)());
    check('o pedido entregue sai das listas em curso do empregado e da cozinha', (await until(async () => !(await wc.isVisible()), { timeout: 8000 })) && (await until(async () => (await kitchen.call('GET', '/api/orders?scope=active')).json.orders.every((o) => o.order_number !== placed.order.order_number), { timeout: 8000 })));
    const final = await publicOrder(cctx.request, code);
    check('o estado final guardado no servidor é "entregue"', final?.status === 'entregue', final?.status);
    await shot(cp, 'cliente-7-entregue');

    check('sem erros nos três ecrãs', problems.length === 0, problems.join(' | '));
    await Promise.all([kctx.close(), wctx.close(), cctx.close()]);
  });

  await scenario('Sem internet: a cozinha e o cliente avisam "Sem ligação" e recuperam sozinhos', async () => {
    const problems = [];
    const kctx = await browser.newContext(PHONE);
    const cctx = await browser.newContext(PHONE);
    const apiCtx = await browser.newContext();
    const [kp, cp] = await Promise.all([kctx.newPage(), cctx.newPage()]);
    watch(kp, problems, { network: true });
    watch(cp, problems, { network: true });

    await loginPage(kp, 'cozinha@terraza.demo');
    await kp.waitForSelector('.pill-live', { timeout: 10000 });

    const first = mark('off1');
    const placed = await placeOrder(apiCtx.request, tables.get(6).token, [{ name: 'Mandioca frita', qty: 1 }], first);
    await cp.goto(`${BASE}/pedido/${placed.order.public_code}`);
    await cp.waitForSelector('.order-ticket');
    check('antes da queda, o cliente vê "Pedido recebido"', await statusIs(cp, 'Pedido recebido')());

    // a rede cai nos dois telemóveis
    await Promise.all([kctx.setOffline(true), cctx.setOffline(true)]);
    check('sem internet, a cozinha avisa "Sem ligação"', await until(visible(kp.locator('.pill-off').first()), { timeout: 25000 }));
    check('sem internet, o cliente é avisado de que está a tentar de novo', await until(async () => /Sem ligação/.test(await cp.locator('.order-link-state').innerText()), { timeout: 25000 }));
    await shot(kp, 'cozinha-2-sem-ligacao');
    await shot(cp, 'cliente-8-sem-ligacao');

    // durante a queda: chega outro pedido e a cozinha avança o primeiro
    const second = mark('off2');
    const placed2 = await placeOrder(apiCtx.request, tables.get(7).token, [{ name: 'Água mineral 0,5 l', qty: 1 }], second);
    check('durante a queda o servidor continua a aceitar pedidos', placed2.status === 201, `${placed2.status}`);
    const mine = (await activeOrders(kitchen)).find((o) => o.order_number === placed.order.order_number);
    const moved = await kitchen.call('POST', `/api/order-status/${mine.id}`, { to: 'em_preparacao' });
    check('durante a queda, a cozinha (noutro aparelho) avança o primeiro pedido', moved.status === 200, `${moved.status} ${moved.text.slice(0, 100)}`);

    // a rede volta
    await Promise.all([kctx.setOffline(false), cctx.setOffline(false)]);
    check('quando a rede volta, a cozinha mostra sozinha o pedido que chegou durante a queda', await until(visible(card(kp, second)), { timeout: 25000 }));
    check('a cozinha volta a "Em tempo real"', await until(visible(kp.locator('.pill-live').first()), { timeout: 25000 }));
    check('quando a rede volta, o cliente vê o estado atual ("Em preparação") sem recarregar', await until(statusIs(cp, 'Em preparação'), { timeout: 25000 }), await statusTitle(cp)());
    await shot(kp, 'cozinha-3-recuperada');

    check('sem erros inesperados (fora os de rede, esperados nesta queda)', problems.length === 0, problems.join(' | '));
    await Promise.all([kctx.close(), cctx.close(), apiCtx.close()]);
  });

  await scenario('Tempo real bloqueado: os ecrãs continuam a atualizar-se, por consulta periódica', async () => {
    const problems = [];
    const kctx = await browser.newContext(PHONE);
    // como numa rede que corta ligações longas: o canal de tempo real nunca abre
    for (const ctx of [kctx]) {
      await ctx.route('**/api/realtime/stream*', (r) => r.abort());
      await ctx.route('**/api/public/orders/*/stream*', (r) => r.abort());
    }
    const kp = await kctx.newPage();
    const cp = await kctx.newPage();
    watch(kp, problems, { network: true });
    watch(cp, problems, { network: true });
    const apiCtx = await browser.newContext();

    await loginPage(kp, 'cozinha@terraza.demo');
    check('sem canal de tempo real, a cozinha avisa que atualiza "de poucos em poucos segundos"', await until(visible(kp.locator('.pill-poll').first()), { timeout: 12000 }));
    await shot(kp, 'cozinha-4-consulta-periodica');

    const note = mark('poll');
    const placed = await placeOrder(apiCtx.request, tables.get(8).token, [{ name: 'Mandioca frita', qty: 1 }], note);
    check('o pedido novo aparece na cozinha pela consulta periódica (em menos de 15 s)', await until(visible(card(kp, note)), { timeout: 15000 }));

    await cp.goto(`${BASE}/pedido/${placed.order.public_code}`);
    await cp.waitForSelector('.order-ticket');
    check('o cliente também avisa que atualiza de poucos em poucos segundos', await until(async () => /poucos em poucos segundos/.test(await cp.locator('.order-link-state').innerText()), { timeout: 10000 }));
    const mine = (await activeOrders(kitchen)).find((o) => o.order_number === placed.order.order_number);
    await kitchen.call('POST', `/api/order-status/${mine.id}`, { to: 'em_preparacao' });
    check('a mudança de estado chega ao cliente pela consulta periódica (em menos de 15 s)', await until(statusIs(cp, 'Em preparação'), { timeout: 15000 }), await statusTitle(cp)());

    check('sem erros inesperados', problems.length === 0, problems.join(' | '));
    await Promise.all([kctx.close(), apiCtx.close()]);
  });
}
