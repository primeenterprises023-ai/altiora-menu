// Parte interativa da página comercial. A página já vem completa do servidor e lê-se sem isto;
// aqui só se acrescenta o menu do telemóvel, os filtros do cardápio de exemplo, a demonstração em 3D,
// as animações de entrada e o envio do formulário de contacto.
import './landing.css';
import '../styles/viewer.css';
import { mountViewer } from '../viewer/mount';

document.documentElement.classList.add('js');

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
const reduceMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------- cabeçalho ----------
function initHeader(): void {
  const header = $('.lp-header');
  const toggle = $<HTMLButtonElement>('.lp-nav-toggle');
  const nav = $('#lp-nav');
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }
  if (!toggle || !nav) return;
  const set = (open: boolean) => {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => set(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) set(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      set(false);
      toggle.focus();
    }
  });
  window.matchMedia?.('(min-width: 900px)').addEventListener?.('change', (e) => e.matches && set(false));
}

// ---------- animações de entrada: só o que está abaixo da dobra, para o topo nunca "piscar" ----------
function initReveal(): void {
  if (reduceMotion() || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        en.target.classList.add('is-in');
        io.unobserve(en.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  for (const el of $$('[data-reveal]')) {
    if (el.getBoundingClientRect().top < window.innerHeight * 0.95) continue;
    el.classList.add('lp-pre');
    io.observe(el);
  }
}

// ---------- filtros do cardápio de exemplo ----------
function initDishFilter(): void {
  const bar = $('.lp-chips');
  if (!bar) return;
  bar.hidden = false;
  const dishes = $$('.lp-dish');
  bar.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.lp-chip');
    if (!chip) return;
    const cat = chip.dataset.cat ?? '';
    for (const c of $$('.lp-chip', bar)) {
      const on = c === chip;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', String(on));
    }
    for (const d of dishes) d.hidden = cat !== '' && d.dataset.category !== cat;
  });
  for (const c of $$('.lp-chip', bar)) c.setAttribute('aria-pressed', String(c.classList.contains('is-on')));
}

// ---------- demonstração em 3D (o motor 3D só é descarregado quando se toca no botão) ----------
function initViewer(): void {
  const stage = $('.lp-3d-stage');
  if (!stage) return;
  const open = $<HTMLButtonElement>('.lp-3d-open', stage);
  const host = $('.v3d-host', stage);
  const status = $('.lp-3d-status', stage);
  const poster = $<HTMLImageElement>('.v3d-poster', stage);
  const src = stage.dataset.model;
  if (!open || !host || !status || !src) return;
  open.hidden = false;
  let started = false;
  const say = (text: string) => {
    status.textContent = text;
    status.hidden = !text;
  };
  open.addEventListener('click', () => {
    if (started) return;
    started = true;
    open.hidden = true;
    say('A carregar o modelo 3D…');
    host.hidden = false;
    const title = stage.dataset.title ?? 'Prato';
    mountViewer(host, {
      src,
      alt: title,
      title,
      ar: true,
      fallbackUrl: location.href,
      onProgress: (f) => say(`A carregar o modelo 3D · ${Math.round(f * 100)} %`),
      onReady: () => {
        say('');
        if (poster) poster.hidden = true;
      },
      onError: (kind) => {
        host.hidden = true;
        say(`${kind === 'webgl' ? 'Este aparelho não consegue mostrar o 3D.' : 'Não foi possível abrir o modelo 3D.'} Veja a fotografia.`);
      },
    }).catch(() => {
      host.hidden = true;
      say('Não foi possível abrir o modelo 3D. Veja a fotografia.');
    });
  });
}

// ---------- formulário de contacto ----------
interface FieldProblem {
  field: string;
  message: string;
}

function initForm(): void {
  const form = $<HTMLFormElement>('#lp-form');
  if (!form) return;
  const sent = $('#lp-sent');
  const formError = $('#lp-form-error');
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  const select = $<HTMLSelectElement>('#f-plan', form);
  const FIELDS = ['name', 'business', 'phone', 'email', 'message', 'consent'] as const;

  // «Pedir o plano X» escolhe o plano no formulário (e também ?plano=codigo no endereço)
  const choose = (code: string | null | undefined) => {
    if (!select || !code) return;
    if ([...select.options].some((o) => o.value === code)) select.value = code;
  };
  choose(new URLSearchParams(location.search).get('plano'));
  document.addEventListener('click', (e) => choose((e.target as HTMLElement).closest<HTMLElement>('a[data-plan]')?.dataset.plan));

  const control = (name: string) => $<HTMLInputElement>(`[name="${name}"]`, form);
  const errBox = (name: string) => $(`#e-${name}`);
  const showErrors = (problems: FieldProblem[]) => {
    for (const f of FIELDS) {
      const box = errBox(f);
      if (box) box.textContent = '';
      control(f)?.removeAttribute('aria-invalid');
    }
    let first: HTMLInputElement | null = null;
    for (const p of problems) {
      const box = errBox(p.field);
      if (!box) continue;
      if (box.textContent) continue; // uma mensagem por campo
      box.textContent = p.message;
      const c = control(p.field);
      c?.setAttribute('aria-invalid', 'true');
      first ??= c;
    }
    first?.focus();
  };
  // ao escrever, o aviso do campo desaparece
  form.addEventListener('input', (e) => {
    const name = (e.target as HTMLInputElement).name;
    const box = errBox(name);
    if (box) box.textContent = '';
    (e.target as HTMLElement).removeAttribute('aria-invalid');
    if (name === 'phone' || name === 'email') {
      for (const n of ['phone', 'email']) {
        const b = errBox(n);
        if (b) b.textContent = '';
        control(n)?.removeAttribute('aria-invalid');
      }
    }
    if (formError) formError.textContent = '';
  });

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const v = (n: string) => (control(n)?.value ?? '').trim();
    const problems: FieldProblem[] = [];
    if (v('name').length < 2) problems.push({ field: 'name', message: 'Indique o seu nome.' });
    if (!v('phone') && !v('email')) problems.push({ field: 'phone', message: 'Indique um telefone ou um e-mail para lhe respondermos.' });
    if (v('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) problems.push({ field: 'email', message: 'O e-mail não parece válido.' });
    if (!control('consent')?.checked) problems.push({ field: 'consent', message: 'Para enviar, aceite que a Altiora Grupo o contacte.' });
    showErrors(problems);
    if (formError) formError.textContent = '';
    if (problems.length) return;

    const planLabel = select && select.value ? select.options[select.selectedIndex]?.text : '';
    const message = [planLabel ? `Plano de interesse: ${planLabel}` : '', v('message')].filter(Boolean).join('\n\n');
    busy = true;
    const label = submit?.textContent ?? '';
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'A enviar…';
    }
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: v('name'), business: v('business'), phone: v('phone'), email: v('email'), message, consent: true, website: v('website') }),
      });
      if (res.ok) {
        form.hidden = true;
        if (sent) {
          sent.hidden = false;
          sent.focus();
        }
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string; details?: unknown } } | null;
      const details = Array.isArray(body?.error?.details) ? (body!.error!.details as FieldProblem[]).filter((d) => d && typeof d.field === 'string' && typeof d.message === 'string') : [];
      if (details.length) showErrors(details);
      else if (formError) formError.textContent = body?.error?.message ?? 'Não foi possível enviar o pedido. Tente outra vez dentro de instantes.';
    } catch {
      if (formError) formError.textContent = 'Não foi possível enviar o pedido. Verifique a ligação à internet e tente outra vez.';
    } finally {
      busy = false;
      if (submit) {
        submit.disabled = false;
        submit.textContent = label;
      }
    }
  });
}

initHeader();
initReveal();
initDishFilter();
initViewer();
initForm();
