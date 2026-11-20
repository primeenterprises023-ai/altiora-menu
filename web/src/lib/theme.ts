// Cor do restaurante: a partir de uma única cor (#RRGGBB) calculam-se as variantes que garantem texto legível
// em modo claro e escuro (contraste mínimo 4,5:1 para texto, como pedem as boas práticas de acessibilidade).
import { local } from './storage';

type RGB = [number, number, number];

const INK: RGB = [0x17, 0x17, 0x1a];
const WHITE: RGB = [255, 255, 255];
const DARK_PAPER: RGB = [0x13, 0x13, 0x16];

export function parseHex(hex: string): RGB | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: RGB) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Aproxima a cor de `target` (preto/branco) até haver contraste suficiente com o fundo. */
function ensureContrast(color: RGB, bg: RGB, target: RGB, min: number): RGB {
  let c = color;
  for (let i = 0; i <= 20 && contrast(c, bg) < min; i++) c = mix(color, target, i / 20);
  return c;
}

export interface AccentVars {
  accent: string;
  onAccent: string;
  textLight: string;
  textDark: string;
  softLight: string;
  softDark: string;
}

export function accentVars(hex: string): AccentVars | null {
  const base = parseHex(hex);
  if (!base) return null;
  const onAccent = contrast(base, INK) >= contrast(base, WHITE) ? INK : WHITE;
  return {
    accent: toHex(base),
    onAccent: toHex(onAccent),
    textLight: toHex(ensureContrast(base, WHITE, [0, 0, 0], 4.7)),
    textDark: toHex(ensureContrast(base, DARK_PAPER, WHITE, 4.7)),
    softLight: toHex(mix(base, WHITE, 0.86)),
    softDark: toHex(mix(base, DARK_PAPER, 0.8)),
  };
}

const DEFAULT_ACCENT = '#c9a24b';

/** Aplica a cor do restaurante a toda a aplicação (null = cor da Altiora). */
export function applyAccent(hex: string | null | undefined): void {
  const v = accentVars(hex && parseHex(hex) ? hex : DEFAULT_ACCENT)!;
  const root = document.documentElement.style;
  root.setProperty('--accent', v.accent);
  root.setProperty('--on-accent', v.onAccent);
  root.setProperty('--accent-text-l', v.textLight);
  root.setProperty('--accent-text-d', v.textDark);
  root.setProperty('--accent-soft-l', v.softLight);
  root.setProperty('--accent-soft-d', v.softDark);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', v.accent);
}

export type ThemeChoice = 'auto' | 'light' | 'dark';
const THEME_KEY = 'altiora:theme';

export function getTheme(): ThemeChoice {
  const v = local.get(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

export function setTheme(choice: ThemeChoice): void {
  if (choice === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    local.remove(THEME_KEY);
  } else {
    document.documentElement.setAttribute('data-theme', choice);
    local.set(THEME_KEY, choice);
  }
}

export function initTheme(): void {
  const t = getTheme();
  if (t !== 'auto') document.documentElement.setAttribute('data-theme', t);
}

/** Tema do restaurante (escuro por omissão, como a marca): vale só enquanto o menu está aberto e não é guardado. */
export function applyRestaurantTheme(theme: 'dark' | 'light'): () => void {
  const el = document.documentElement;
  const before = el.getAttribute('data-theme');
  el.setAttribute('data-theme', theme);
  return () => {
    if (before) el.setAttribute('data-theme', before);
    else el.removeAttribute('data-theme');
  };
}
