// Página comercial do ALTIORA MENU e aviso de privacidade.
// O HTML é escrito no servidor: abre depressa, é lido pelos motores de busca e funciona mesmo sem JavaScript.
// O ficheiro landing.js só acrescenta o que é interativo (filtros, demonstração em 3D, menu do telemóvel e envio do formulário).
// Todos os textos que vêm da base de dados ou da configuração passam por esc()/safeUrl(): nada é inserido sem tratamento.
import { formatMoney } from '../../../shared/money';
import { encodeQr, qrSvg } from '../../../shared/qr';
import type { LandingAssets, LandingContacts, LandingData, LandingDish, LandingPlan } from '../../../shared/landing';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Só aceita endereços do próprio site ("/a/…") ou https: nunca "javascript:", "data:" nem "//outro-site". */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (/^\/(?![/\\])/.test(u)) return u;
  if (/^https:\/\//i.test(u)) return u;
  return null;
}

const digits = (v: string): string => v.replace(/\D/g, '');

// ---------------------------------------------------------------------------------------------------------------------
// ícones (linhas, 24×24) — desenhados à mão, sem bibliotecas
// ---------------------------------------------------------------------------------------------------------------------
const ICONS = {
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h3v3h-3zM20 14v2M14 20h2M18 19h2v2h-2z"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  cube: '<path d="M12 2.5l8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3z"/><path d="M12 12l8.5-4.7M12 12v9.5M12 12L3.5 7.3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  shield: '<path d="M12 2.5l7.5 3v6c0 4.7-3.2 8.2-7.5 10-4.3-1.8-7.5-5.3-7.5-10v-6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  store: '<path d="M4 9.5L5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0 2.7 2.7 0 005.3 0"/><path d="M5 12.5V20h14v-7.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
  pin: '<path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0113 0c0 5.3-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  call: '<path d="M5 4h4l1.5 4-2 1.5a11 11 0 005 5l1.5-2 4 1.5v4a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z"/>',
} as const;
type IconName = keyof typeof ICONS;

const icon = (name: IconName, cls = ''): string =>
  `<svg class="lp-ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const MARK =
  '<svg class="lp-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><rect x="3" y="3" width="26" height="26" rx="7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9.5 22.5L16 9l6.5 13.5M12 18.2h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------------------------------------------------------------
// textos
// ---------------------------------------------------------------------------------------------------------------------
const TITLE = 'ALTIORA MENU — Cardápios digitais com QR Code, 3D e realidade aumentada';
const DESCRIPTION = 'Cardápios digitais para restaurantes: QR Code por mesa, pratos em 3D e realidade aumentada, pedidos em tempo real e preços em Kwanza. Sem aplicação para instalar.';

interface Faq {
  q: string;
  a: string;
}
const FAQ: Faq[] = [
  { q: 'Os clientes precisam de instalar alguma aplicação?', a: 'Não. O cliente lê o QR Code com a câmara do telemóvel e o cardápio abre no navegador, como uma página normal.' },
  {
    q: 'Tenho de ter modelos 3D de todos os pratos?',
    a: 'Não. Os pratos que têm modelo 3D mostram o botão «Ver em 3D»; os restantes mostram a fotografia. Pode começar só com fotografias e juntar modelos mais tarde, no plano que inclui 3D.',
  },
  {
    q: 'Como funciona a realidade aumentada («Ver na minha mesa»)?',
    a: 'Em telemóveis compatíveis, o cliente pousa o prato virtual na mesa, através da câmara. O botão só aparece em aparelhos que o permitem; nos outros, o cliente vê o prato em 3D ou a fotografia.',
  },
  {
    q: 'Como recebo os pedidos?',
    a: 'Pelo sistema: a cozinha e os empregados veem cada pedido em tempo real, por mesa. Se preferir, o cliente envia o pedido já escrito para o WhatsApp do restaurante. Cada opção depende do plano escolhido.',
  },
  { q: 'O sistema cobra pagamentos aos clientes?', a: 'Não. O cliente não paga pelo telemóvel: faz o pedido e, se precisar de ajuda, chama o garçom com um toque. O pagamento faz-se no restaurante, como hoje.' },
  {
    q: 'Os dados do meu restaurante ficam separados dos outros?',
    a: 'Sim. Cada restaurante só vê os seus próprios dados. A equipa da Altiora vê o estado, o plano e números gerais de utilização, mas não os pedidos, os menus nem os relatórios dos restaurantes.',
  },
  {
    q: 'Em que moedas posso mostrar os preços?',
    a: 'Em Kwanza (AOA) e noutras moedas: dólar, euro, real, metical, escudo cabo-verdiano, rand e libra. A moeda escolhe-se ao criar o restaurante e não se muda depois de haver pedidos.',
  },
  { q: 'Posso mudar de plano mais tarde?', a: 'Sim. A Altiora altera o plano do restaurante e as funcionalidades novas ficam disponíveis em poucos segundos.' },
  { q: 'Quanto custa?', a: 'Os preços de cada plano estão na secção Planos. Onde ainda não houver preço indicado, peça uma proposta pelo formulário e dizemos-lhe o valor para o seu restaurante.' },
];

const BENEFITS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'phone', title: 'Sem aplicação', text: 'Funciona no navegador do telemóvel. O cliente lê o QR Code e já está no cardápio.' },
  { icon: 'bolt', title: 'Atualiza em segundos', text: 'Mude preços, esgote um prato ou acrescente novidades. O QR Code impresso continua a servir.' },
  { icon: 'cube', title: 'Pratos que se veem antes de pedir', text: 'Fotografias, ingredientes, alergénios e, onde existir, o prato em 3D e na mesa do cliente.' },
  { icon: 'bell', title: 'Pedidos e chamadas sem confusão', text: 'A cozinha e os empregados recebem os pedidos em tempo real; o cliente chama o garçom com um toque.' },
  { icon: 'chart', title: 'Números que ajudam a decidir', text: 'Vendas por dia, pratos mais vendidos e exportação para folha de cálculo (planos com estatísticas).' },
  { icon: 'shield', title: 'Cada restaurante, os seus dados', text: 'Os dados de cada restaurante estão separados. A Altiora não vê os seus pedidos nem os seus relatórios.' },
];

const FEATURE_GROUPS: Array<{ title: string; icon: IconName; items: string[] }> = [
  {
    title: 'Para o cliente',
    icon: 'phone',
    items: [
      'Pesquisa instantânea e filtros por categoria',
      'Ingredientes e alergénios em cada prato',
      'Tamanhos e extras à escolha',
      'Prato em 3D e na mesa (realidade aumentada) quando existe modelo',
      'Carrinho com notas e envio do pedido',
      'Chamar o garçom com um toque',
    ],
  },
  {
    title: 'Para a equipa',
    icon: 'bell',
    items: [
      'Ecrã da cozinha com os pedidos novos em tempo real',
      'Ecrã do empregado com as chamadas de cada mesa',
      'Estados do pedido: novo, em preparação, pronto, entregue',
      'Um QR Code por mesa, em PDF pronto a imprimir',
    ],
  },
  {
    title: 'Para o dono',
    icon: 'store',
    items: [
      'Pratos, categorias, preços, fotografias e modelos 3D',
      'Disponível ou esgotado em segundos',
      'Estatísticas e pratos mais vendidos, com exportação em CSV',
      'Registo da atividade da equipa',
      'Logótipo, capa e cores do restaurante',
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// peças da página
// ---------------------------------------------------------------------------------------------------------------------
function header(hasDemo: boolean, has3d: boolean): string {
  const links = [
    hasDemo ? ['#cardapio', 'Cardápio'] : null,
    has3d ? ['#modelo-3d', '3D e AR'] : null,
    ['#funcionalidades', 'Funcionalidades'],
    ['#planos', 'Planos'],
    ['#perguntas', 'Perguntas'],
  ].filter((x): x is string[] => x !== null);
  return `<a class="lp-skip" href="#conteudo">Saltar para o conteúdo</a>
<header class="lp-header" id="topo">
  <div class="lp-wrap lp-header-row">
    <a class="lp-brand" href="/" aria-label="ALTIORA MENU — início">${MARK}<span class="lp-brand-name">ALTIORA <b>MENU</b></span></a>
    <button class="lp-nav-toggle" type="button" aria-expanded="false" aria-controls="lp-nav"><span class="lp-sr">Menu</span><span class="lp-burger" aria-hidden="true"></span></button>
    <nav class="lp-nav" id="lp-nav" aria-label="Principal">
      <ul>${links.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('')}</ul>
      <a class="lp-btn lp-btn-gold lp-btn-sm" href="#contacto">Pedir demonstração</a>
    </nav>
  </div>
</header>`;
}

function heroPhone(d: LandingData): string {
  const demo = d.demo;
  if (!demo) {
    // sem restaurante de demonstração: um ecrã ilustrativo, sem pratos nem preços inventados
    return `<div class="lp-phone" role="img" aria-label="Ilustração de um cardápio num telemóvel"><div class="lp-phone-screen">
      <div class="lp-phone-top"><span class="lp-phone-logo">${MARK}</span><div><p class="lp-phone-name">O seu restaurante</p><p class="lp-phone-sub">Mesa 5 · Cardápio</p></div></div>
      <div class="lp-phone-chips"><span class="is-on">Todos</span><span>Entradas</span><span>Pratos</span></div>
      ${'<div class="lp-phone-row lp-phone-skel"><span class="lp-skel-img"></span><div><span class="lp-skel-line"></span><span class="lp-skel-line lp-skel-short"></span></div></div>'.repeat(3)}
    </div></div>`;
  }
  const cats = [...new Set(demo.dishes.map((x) => x.category))].slice(0, 2);
  const logo = safeUrl(demo.logo_url);
  const rows = demo.dishes.slice(0, 4);
  return `<div class="lp-phone" role="img" aria-label="Exemplo do cardápio de ${esc(demo.name)} no telemóvel"><div class="lp-phone-screen">
      <div class="lp-phone-top">${logo ? `<img class="lp-phone-logo" src="${esc(logo)}" alt="" width="36" height="36" decoding="async" />` : `<span class="lp-phone-logo">${MARK}</span>`}<div><p class="lp-phone-name">${esc(demo.name)}</p><p class="lp-phone-sub">Mesa 5 · Cardápio</p></div></div>
      <div class="lp-phone-chips"><span class="is-on">Todos</span>${cats.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
      ${rows
        .map((r) => {
          const img = safeUrl(r.thumb_url ?? r.image_url);
          return `<div class="lp-phone-row">${img ? `<img src="${esc(img)}" alt="" width="56" height="56" decoding="async" />` : '<span class="lp-skel-img"></span>'}<div><p class="lp-phone-dish">${esc(r.name)}</p><p class="lp-phone-price">${esc(formatMoney(r.price_cents, demo.currency))}</p></div>${r.model_url ? '<span class="lp-phone-3d">3D</span>' : ''}</div>`;
        })
        .join('')}
    </div></div>`;
}

function hero(d: LandingData): string {
  const demo = d.demo;
  const qr = demo ? qrSvg(encodeQr(`${d.base_url}/r/${demo.slug}`, 'M'), { quiet: 1, dark: '#0d0d0f', light: '#fbfaf7' }) : null;
  return `<section class="lp-hero" aria-labelledby="lp-h1">
  <div class="lp-hero-glow" aria-hidden="true"></div>
  <div class="lp-wrap lp-hero-grid">
    <div class="lp-hero-copy">
      <p class="lp-eyebrow">Digital Dining Experience</p>
      <h1 id="lp-h1">O cardápio do seu restaurante, num QR Code e <span class="lp-gold">em 3D</span>.</h1>
      <p class="lp-lead">Os clientes leem o QR Code da mesa e veem o menu no telemóvel, com fotografias, preços em Kwanza e pratos em 3D. Sem instalar nenhuma aplicação.</p>
      <div class="lp-cta-row">
        <a class="lp-btn lp-btn-gold" href="#contacto">Pedir demonstração ${icon('arrow')}</a>
        ${demo ? `<a class="lp-btn lp-btn-ghost-light" href="/r/${esc(demo.slug)}">Ver um cardápio de exemplo</a>` : '<a class="lp-btn lp-btn-ghost-light" href="#funcionalidades">Ver funcionalidades</a>'}
      </div>
      <ul class="lp-proof"><li>${icon('check')}Sem aplicação para instalar</li><li>${icon('check')}QR Code por mesa</li><li>${icon('check')}Preços em Kwanza e outras moedas</li></ul>
    </div>
    <div class="lp-hero-visual">
      ${heroPhone(d)}
      ${qr ? `<figure class="lp-qrcard"><div class="lp-qrcard-img">${qr}</div><figcaption>Aponte a câmara do telemóvel: abre o cardápio de exemplo.</figcaption></figure>` : ''}
    </div>
  </div>
</section>`;
}

function steps(): string {
  const items: Array<[IconName, string, string]> = [
    ['qr', 'Imprima o QR Code', 'Gere o PDF do restaurante ou de cada mesa, pronto a imprimir e a colocar na mesa.'],
    ['phone', 'O cliente abre o cardápio', 'Fotografias, ingredientes, alergénios, tamanhos e extras. Nos pratos com modelo, «Ver em 3D» e «Ver na minha mesa».'],
    ['bell', 'O pedido chega à equipa', 'Pelo sistema, em tempo real para a cozinha e os empregados, ou por WhatsApp. O cliente pode ainda chamar o garçom.'],
  ];
  return `<section class="lp-section" id="como-funciona" aria-labelledby="lp-h-steps">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Como funciona</p><h2 id="lp-h-steps">Três passos, sem aplicação</h2></header>
    <ol class="lp-steps">${items.map(([ic, t, p], i) => `<li class="lp-step" data-reveal><span class="lp-step-n" aria-hidden="true">${i + 1}</span><span class="lp-step-ic">${icon(ic)}</span><h3>${t}</h3><p>${p}</p></li>`).join('')}</ol>
  </div>
</section>`;
}

function dishCard(x: LandingDish, currency: string): string {
  const img = safeUrl(x.thumb_url ?? x.image_url);
  return `<article class="lp-dish" data-category="${esc(x.category)}">
      <div class="lp-dish-media">${img ? `<img src="${esc(img)}" alt="${esc(x.name)}" width="480" height="360" loading="lazy" decoding="async" />` : `<span class="lp-dish-noimg">${icon('layers')}</span>`}${x.model_url ? '<span class="lp-tag">3D</span>' : ''}</div>
      <div class="lp-dish-body">
        <p class="lp-dish-cat">${esc(x.category)}</p>
        <h3>${esc(x.name)}</h3>
        ${x.description ? `<p class="lp-dish-desc">${esc(x.description)}</p>` : ''}
        <div class="lp-dish-foot"><span class="lp-price">${esc(formatMoney(x.price_cents, currency))}</span>${x.allergens.length ? `<span class="lp-allergens" title="Alergénios">${x.allergens.slice(0, 3).map((a) => `<span>${esc(a)}</span>`).join('')}</span>` : ''}</div>
      </div>
    </article>`;
}

function demoMenu(d: LandingData): string {
  const demo = d.demo;
  if (!demo || demo.dishes.length === 0) return '';
  const cats = [...new Set(demo.dishes.map((x) => x.category))];
  return `<section class="lp-section lp-alt" id="cardapio" aria-labelledby="lp-h-menu">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal>
      <p class="lp-eyebrow lp-eyebrow-dark">Cardápio de exemplo</p>
      <h2 id="lp-h-menu">É assim que o cliente vê o menu</h2>
      <p>Pratos do restaurante de demonstração «${esc(demo.name)}»: fotografia, preço, alergénios e, onde existe, o selo 3D.</p>
    </header>
    ${cats.length > 1 ? `<div class="lp-chips" role="group" aria-label="Filtrar por categoria" hidden><button type="button" class="lp-chip is-on" data-cat="">Todos</button>${cats.map((c) => `<button type="button" class="lp-chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
    <div class="lp-dish-grid" data-reveal>${demo.dishes.map((x) => dishCard(x, demo.currency)).join('')}</div>
    <p class="lp-note">Pratos, imagens e preços de exemplo, criados só para esta demonstração. No seu restaurante serão os seus.</p>
    <p class="lp-center"><a class="lp-btn lp-btn-dark" href="/r/${esc(demo.slug)}">Abrir o cardápio completo ${icon('arrow')}</a></p>
  </div>
</section>`;
}

function demo3d(d: LandingData): string {
  const dish = d.demo?.model_dish;
  const model = safeUrl(dish?.model_url);
  if (!d.demo || !dish || !model) return '';
  const poster = safeUrl(dish.image_url);
  return `<section class="lp-section lp-dark" id="modelo-3d" aria-labelledby="lp-h-3d">
  <div class="lp-wrap lp-3d-grid">
    <div class="lp-3d-copy" data-reveal>
      <p class="lp-eyebrow">3D e realidade aumentada</p>
      <h2 id="lp-h-3d">Veja o prato antes de o pedir</h2>
      <p class="lp-lead">Toque em «Ver em 3D» e rode o prato com o dedo. Em telemóveis compatíveis, «Ver na minha mesa» pousa o prato em cima da mesa, através da câmara.</p>
      <ul class="lp-checks">
        <li>${icon('check')}Roda e amplia com os dedos</li>
        <li>${icon('check')}Só aparece nos pratos que têm modelo; nos outros, fica a fotografia</li>
        <li>${icon('check')}A realidade aumentada depende do telemóvel e nunca é simulada</li>
      </ul>
      <p class="lp-note lp-note-dark">Modelo de demonstração, gerado por computador.</p>
    </div>
    <div class="lp-3d-stage" data-reveal data-model="${esc(model)}" data-title="${esc(dish.name)}" data-fallback="/r/${esc(d.demo.slug)}">
      <div class="v3d-wrap lp-3d-wrap">
        ${poster ? `<img class="v3d-poster" src="${esc(poster)}" alt="${esc(dish.name)}" width="1200" height="900" loading="lazy" decoding="async" />` : ''}
        <div class="v3d-host" hidden></div>
        <button class="lp-btn lp-btn-gold lp-3d-open" type="button" hidden>${icon('cube')}Ver em 3D</button>
        <p class="v3d-status lp-3d-status" role="status" hidden></p>
      </div>
      <p class="lp-3d-caption"><strong>${esc(dish.name)}</strong> · ${esc(formatMoney(dish.price_cents, d.demo.currency))}</p>
    </div>
  </div>
</section>`;
}

function benefits(): string {
  return `<section class="lp-section" id="beneficios" aria-labelledby="lp-h-ben">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Porquê o ALTIORA MENU</p><h2 id="lp-h-ben">Menos papel, menos filas, mais pedidos certos</h2></header>
    <div class="lp-cards">${BENEFITS.map((b) => `<article class="lp-card" data-reveal><span class="lp-card-ic">${icon(b.icon)}</span><h3>${b.title}</h3><p>${b.text}</p></article>`).join('')}</div>
  </div>
</section>`;
}

function features(): string {
  return `<section class="lp-section lp-alt" id="funcionalidades" aria-labelledby="lp-h-feat">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Funcionalidades</p><h2 id="lp-h-feat">Tudo o que o restaurante usa no dia a dia</h2></header>
    <div class="lp-feat-grid">${FEATURE_GROUPS.map((g) => `<article class="lp-feat" data-reveal><h3><span class="lp-card-ic">${icon(g.icon)}</span>${g.title}</h3><ul>${g.items.map((i) => `<li>${icon('check')}<span>${i}</span></li>`).join('')}</ul></article>`).join('')}</div>
  </div>
</section>`;
}

/** O que cada plano acrescenta ao anterior (se o anterior estiver todo incluído); senão, tudo o que inclui. */
export function planBullets(plans: LandingPlan[], i: number): { lead: string | null; items: string[] } {
  const cur = plans[i]!;
  const included = cur.features.filter((f) => f.included);
  const prev = plans[i - 1];
  if (prev) {
    const prevKeys = prev.features.filter((f) => f.included).map((f) => f.key);
    const curKeys = new Set(included.map((f) => f.key));
    if (prevKeys.length > 0 && prevKeys.every((k) => curKeys.has(k))) {
      const extra = included.filter((f) => !prevKeys.includes(f.key));
      return extra.length > 0
        ? { lead: `Tudo do plano ${prev.name}, e ainda:`, items: extra.map((f) => f.label) }
        : { lead: `Inclui o mesmo que o plano ${prev.name}.`, items: [] };
    }
  }
  return { lead: null, items: included.map((f) => f.label) };
}

function planCard(plans: LandingPlan[], i: number): string {
  const p = plans[i]!;
  const b = planBullets(plans, i);
  const price = p.price
    ? `<p class="lp-plan-price"><span class="lp-plan-amount">${esc(formatMoney(p.price.monthly_cents, p.price.currency))}</span> <span class="lp-plan-per">por mês</span></p>${p.price.yearly_cents !== null ? `<p class="lp-plan-year">ou ${esc(formatMoney(p.price.yearly_cents, p.price.currency))} por ano</p>` : ''}`
    : '<p class="lp-plan-price lp-plan-ask">Preço sob consulta</p>';
  return `<article class="lp-plan${p.highlighted ? ' is-hot' : ''}" data-reveal>
      ${p.highlighted ? '<p class="lp-plan-badge">Mais escolhido</p>' : ''}
      <h3>${esc(p.name)}</h3>
      ${p.tagline ? `<p class="lp-plan-tag">${esc(p.tagline)}</p>` : ''}
      ${price}
      ${b.lead ? `<p class="lp-plan-lead">${esc(b.lead)}</p>` : ''}
      ${b.items.length ? `<ul class="lp-plan-list">${b.items.map((t) => `<li>${icon('check')}<span>${esc(t)}</span></li>`).join('')}</ul>` : ''}
      <a class="lp-btn ${p.highlighted ? 'lp-btn-gold' : 'lp-btn-ghost-light'} lp-btn-block" href="#contacto" data-plan="${esc(p.code)}">Pedir o plano ${esc(p.name)}</a>
    </article>`;
}

function plans(d: LandingData): string {
  if (d.plans.length === 0) return '';
  return `<section class="lp-section lp-dark lp-plans" id="planos" aria-labelledby="lp-h-plans">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal>
      <p class="lp-eyebrow">Planos</p>
      <h2 id="lp-h-plans">Comece simples. Cresça quando quiser.</h2>
      <p class="lp-lead">Escolha o plano que serve o seu restaurante hoje e mude mais tarde, sem perder o cardápio nem os QR Codes.</p>
    </header>
    <div class="lp-plan-grid">${d.plans.map((_, i) => planCard(d.plans, i)).join('')}</div>
    <p class="lp-note lp-note-dark lp-center">Os preços são definidos pela Altiora Grupo e podem mudar. O ALTIORA MENU não cobra pagamentos aos clientes dos restaurantes.</p>
  </div>
</section>`;
}

function interactiveDemo(d: LandingData): string {
  const demo = d.demo;
  if (!demo) return '';
  return `<section class="lp-section lp-alt" id="demonstracao" aria-labelledby="lp-h-demo">
  <div class="lp-wrap lp-demo-grid">
    <div class="lp-demo-copy" data-reveal>
      <p class="lp-eyebrow lp-eyebrow-dark">Demonstração interativa</p>
      <h2 id="lp-h-demo">Experimente agora, sem instalar nada</h2>
      <p>Este é um cardápio a funcionar: use a pesquisa, filtre por categoria e abra um prato para ver os detalhes e, onde existir, o 3D.</p>
      <p><a class="lp-btn lp-btn-dark" href="/r/${esc(demo.slug)}">Abrir em ecrã inteiro ${icon('arrow')}</a></p>
    </div>
    <div class="lp-demo-device" data-reveal>
      <div class="lp-demo-frame"><a class="lp-demo-fallback" href="/r/${esc(demo.slug)}">Abrir a demonstração</a><iframe title="Cardápio de demonstração interativo" src="/r/${esc(demo.slug)}?embed=1" loading="lazy" width="390" height="780" referrerpolicy="no-referrer"></iframe></div>
    </div>
  </div>
</section>`;
}

function faq(): string {
  return `<section class="lp-section" id="perguntas" aria-labelledby="lp-h-faq">
  <div class="lp-wrap lp-narrow">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Perguntas frequentes</p><h2 id="lp-h-faq">O que costumam perguntar-nos</h2></header>
    <div class="lp-faq" data-reveal>${FAQ.map((f) => `<details class="lp-faq-item"><summary>${esc(f.q)}</summary><div class="lp-faq-a"><p>${esc(f.a)}</p></div></details>`).join('')}</div>
  </div>
</section>`;
}

function contactList(c: LandingContacts): string {
  const items: string[] = [];
  if (c.email) items.push(`<li>${icon('mail')}<a href="mailto:${esc(c.email)}">${esc(c.email)}</a></li>`);
  if (c.phone) items.push(`<li>${icon('call')}<a href="tel:+${esc(digits(c.phone))}">${esc(c.phone)}</a></li>`);
  if (c.whatsapp) {
    const text = encodeURIComponent('Olá! Quero saber mais sobre o ALTIORA MENU.');
    items.push(`<li>${icon('chat')}<a href="https://wa.me/${esc(digits(c.whatsapp))}?text=${text}" rel="noopener">WhatsApp: +${esc(digits(c.whatsapp))}</a></li>`);
  }
  if (c.address) items.push(`<li>${icon('pin')}<span>${esc(c.address)}</span></li>`);
  return items.length ? `<ul class="lp-contact-list">${items.join('')}</ul>` : '';
}

function field(id: string, label: string, attrs: string, opts: { area?: boolean; optional?: boolean; hint?: string } = {}): string {
  const control = opts.area ? `<textarea id="f-${id}" name="${id}" rows="4" maxlength="1400" ${attrs}></textarea>` : `<input id="f-${id}" name="${id}" ${attrs} />`;
  return `<div class="lp-field"><label for="f-${id}">${label}${opts.optional ? ' <span class="lp-opt">(opcional)</span>' : ''}</label>${control}${opts.hint ? `<p class="lp-hint">${opts.hint}</p>` : ''}<p class="lp-err" id="e-${id}" role="alert"></p></div>`;
}

function contact(d: LandingData): string {
  const list = contactList(d.contacts);
  return `<section class="lp-section lp-dark" id="contacto" aria-labelledby="lp-h-contact">
  <div class="lp-wrap lp-contact-grid">
    <div class="lp-contact-copy" data-reveal>
      <p class="lp-eyebrow">Contacto comercial</p>
      <h2 id="lp-h-contact">Vamos pôr o seu cardápio no telemóvel dos clientes</h2>
      <p class="lp-lead">Diga-nos como se chama o restaurante e como o podemos contactar. Respondemos com uma proposta, sem compromisso.</p>
      ${list}
    </div>
    <div data-reveal>
      <noscript><style>.lp-form{display:none}</style><p class="lp-note lp-note-dark">O formulário precisa de JavaScript.${list ? ' Use os contactos ao lado.' : ''}</p></noscript>
      <form class="lp-form" id="lp-form" novalidate action="/api/leads" method="post" aria-label="Pedir demonstração ou proposta">
        ${field('name', 'O seu nome', 'type="text" autocomplete="name" required maxlength="120"')}
        ${field('business', 'Restaurante', 'type="text" autocomplete="organization" maxlength="160"', { optional: true })}
        <div class="lp-row">
          ${field('phone', 'Telefone ou WhatsApp', 'type="tel" inputmode="tel" autocomplete="tel" maxlength="40"')}
          ${field('email', 'E-mail', 'type="email" autocomplete="email" maxlength="160"')}
        </div>
        <p class="lp-hint lp-hint-top">Indique pelo menos um dos dois para lhe respondermos.</p>
        <div class="lp-field"><label for="f-plan">Plano em que tem interesse <span class="lp-opt">(opcional)</span></label>
          <select id="f-plan" name="plan"><option value="">Ainda não sei</option>${d.plans.map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}</select></div>
        ${field('message', 'Mensagem', 'maxlength="1400" placeholder="Quantas mesas tem? Quer pratos em 3D?"', { area: true, optional: true })}
        <div class="lp-hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off" /></label></div>
        <div class="lp-field lp-consent"><label class="lp-check"><input type="checkbox" id="f-consent" name="consent" /><span>Aceito que a Altiora Grupo me contacte sobre o ALTIORA MENU. Veja o <a href="/privacidade">aviso de privacidade</a>.</span></label><p class="lp-err" id="e-consent" role="alert"></p></div>
        <p class="lp-form-error" id="lp-form-error" role="alert"></p>
        <button class="lp-btn lp-btn-gold lp-btn-block" type="submit">Enviar pedido</button>
      </form>
      <div class="lp-sent" id="lp-sent" role="status" tabindex="-1" hidden><span class="lp-sent-ic">${icon('check')}</span><h3>Recebemos o seu pedido</h3><p>Obrigado! Vamos contactá-lo em breve.</p></div>
    </div>
  </div>
</section>`;
}

/** `home` é o prefixo das âncoras: '' na própria página inicial, '/' nas outras páginas (para as secções existirem no destino). */
function footer(d: LandingData, home = ''): string {
  return `<footer class="lp-footer">
  <div class="lp-wrap lp-footer-row">
    <div><a class="lp-brand" href="/" aria-label="ALTIORA MENU — início">${MARK}<span class="lp-brand-name">ALTIORA <b>MENU</b></span></a><p class="lp-footer-sig">Digital Dining Experience</p></div>
    <nav aria-label="Rodapé"><ul><li><a href="${home}#planos">Planos</a></li><li><a href="${home}#perguntas">Perguntas</a></li><li><a href="/privacidade">Privacidade</a></li><li><a href="/entrar">Área do restaurante</a></li></ul></nav>
  </div>
  <div class="lp-wrap lp-footer-legal"><p>© ${d.year} Altiora Grupo. Todos os direitos reservados.</p></div>
</footer>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// documento
// ---------------------------------------------------------------------------------------------------------------------
function jsonLd(d: LandingData): string {
  const base = d.base_url;
  const org: Record<string, unknown> = { '@type': 'Organization', '@id': `${base}/#org`, name: 'Altiora Grupo', url: `${base}/` };
  const contactPoint: Record<string, unknown> = { '@type': 'ContactPoint', contactType: 'sales', availableLanguage: ['pt'] };
  if (d.contacts.email) contactPoint.email = d.contacts.email;
  if (d.contacts.phone) contactPoint.telephone = d.contacts.phone;
  if (d.contacts.email || d.contacts.phone) org.contactPoint = contactPoint;
  const offers = d.plans
    .filter((p) => p.price)
    .map((p) => ({ '@type': 'Offer', name: `Plano ${p.name}`, price: (p.price!.monthly_cents / 100).toFixed(2), priceCurrency: p.price!.currency }));
  const app: Record<string, unknown> = {
    '@type': 'SoftwareApplication',
    name: 'ALTIORA MENU',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: DESCRIPTION,
    publisher: { '@id': `${base}/#org` },
  };
  if (offers.length) app.offers = offers; // só há ofertas se a Altiora definiu preços: nunca se inventam
  const graph = [
    org,
    { '@type': 'WebSite', '@id': `${base}/#site`, url: `${base}/`, name: 'ALTIORA MENU', inLanguage: 'pt-AO', publisher: { '@id': `${base}/#org` } },
    app,
    { '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
  ];
  // "<" escapado: nenhum texto consegue fechar a etiqueta <script>
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

function document(opts: { title: string; description: string; canonical: string; d: LandingData; a: LandingAssets; body: string; ld?: string; index: boolean }): string {
  const { d, a } = opts;
  const og = `${d.base_url}/landing/og.jpg`;
  return `<!doctype html>
<html lang="pt-AO">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}" />
<meta name="robots" content="${opts.index ? 'index, follow, max-image-preview:large' : 'noindex'}" />
<meta name="theme-color" content="#070708" />
<link rel="canonical" href="${esc(opts.canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:locale" content="pt_AO" />
<meta property="og:site_name" content="ALTIORA MENU" />
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:url" content="${esc(opts.canonical)}" />
<meta property="og:image" content="${esc(og)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
${a.font ? `<link rel="preload" href="${esc(a.font)}" as="font" type="font/woff" crossorigin />` : ''}
<link rel="stylesheet" href="${esc(a.css)}" />
${opts.ld ? `<script type="application/ld+json">${opts.ld}</script>` : ''}
<script type="module" src="${esc(a.js)}"></script>
</head>
<body>
${opts.body}
</body>
</html>`;
}

export function renderLanding(d: LandingData, a: LandingAssets): string {
  const hasDemo = !!d.demo && d.demo.dishes.length > 0;
  const has3d = !!d.demo?.model_dish?.model_url;
  const body = `${header(hasDemo, has3d)}
<main id="conteudo">
${hero(d)}
${steps()}
${demoMenu(d)}
${demo3d(d)}
${benefits()}
${features()}
${plans(d)}
${interactiveDemo(d)}
${faq()}
${contact(d)}
</main>
${footer(d)}`;
  return document({ title: TITLE, description: DESCRIPTION, canonical: `${d.base_url}/`, d, a, body, ld: jsonLd(d), index: true });
}

export function renderPrivacy(d: LandingData, a: LandingAssets): string {
  const mail = d.contacts.email;
  const how = mail ? `escreva-nos para <a href="mailto:${esc(mail)}">${esc(mail)}</a>` : 'use o <a href="/#contacto">formulário de contacto</a>';
  const body = `${header(false, false).replace(/href="#/g, 'href="/#')}
<main id="conteudo" class="lp-legal">
  <div class="lp-wrap lp-narrow">
    <p class="lp-eyebrow lp-eyebrow-dark">Aviso de privacidade</p>
    <h1>Como tratamos os seus dados</h1>
    <p class="lp-lead-dark">O ALTIORA MENU é um serviço da Altiora Grupo. Este texto explica, em linguagem simples, que dados recolhemos, para quê e como pode pedir a correção ou o apagamento.</p>

    <h2>Quando nos contacta pela página comercial</h2>
    <p>O formulário pede o seu nome e, se quiser, o nome do restaurante, o telefone, o e-mail e uma mensagem. Usamos estes dados só para responder ao seu pedido e acompanhar a conversa comercial. Ficam guardados no sistema do ALTIORA MENU e só a equipa comercial da Altiora Grupo os vê.</p>

    <h2>Quando navega nesta página</h2>
    <p>Esta página não usa cookies de publicidade nem de medição e não carrega programas de terceiros. A demonstração incluída na página é um cardápio de exemplo, com pratos fictícios.</p>

    <h2>Se é cliente de um restaurante que usa o ALTIORA MENU</h2>
    <p>Não precisa de criar conta. O carrinho e o histórico dos seus pedidos ficam guardados no seu próprio telemóvel. Quando faz um pedido, o restaurante recebe o conteúdo do pedido (pratos, mesa e as notas que escrever) e guarda-o para o servir e gerir o seu negócio. Não escreva nas notas dados que não quer partilhar. O restaurante é responsável pelo tratamento dos pedidos que recebe.</p>

    <h2>Contas da equipa</h2>
    <p>Quem trabalha num restaurante ou na Altiora Grupo entra com e-mail e palavra-passe. Para isso usamos um cookie de sessão, indispensável ao funcionamento, que é apagado quando termina a sessão (ou ao fim do prazo de validade). As palavras-passe nunca são guardadas em texto legível.</p>

    <h2>Quem vê o quê</h2>
    <p>Cada restaurante só tem acesso aos seus dados. A equipa da Altiora Grupo vê o estado e o plano de cada restaurante e números gerais de utilização, mas não vê os pedidos, os menus nem os relatórios dos restaurantes.</p>

    <h2>Como corrigir ou apagar os seus dados</h2>
    <p>Para pedir a correção ou o apagamento dos dados que nos enviou pelo formulário, ${how}. Para dados de pedidos feitos num restaurante, fale com o próprio restaurante.</p>

    <p class="lp-note"><a href="/">← Voltar à página inicial</a></p>
  </div>
</main>
${footer(d, '/')}`;
  return document({ title: 'Privacidade — ALTIORA MENU', description: 'Como o ALTIORA MENU trata os dados de contacto, dos clientes dos restaurantes e das equipas.', canonical: `${d.base_url}/privacidade`, d, a, body, index: true });
}
