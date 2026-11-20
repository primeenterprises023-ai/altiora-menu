import { formatMoney } from '../../../shared/money';

/** Moeda do restaurante em uso (cada pessoa vê um restaurante de cada vez). É definida quando os dados do restaurante chegam. */
let currency = 'AOA';
export const setCurrency = (code: string | null | undefined): void => {
  currency = code || 'AOA';
};
export const getCurrency = (): string => currency;
/** Formata cêntimos na moeda do restaurante (o nome "kz" ficou por hábito; com Kwanzas é o valor por omissão). */
export const kz = (cents: number): string => formatMoney(cents, currency);

const pad = (n: number) => String(n).padStart(2, '0');
const partsCache = new Map<string, Intl.DateTimeFormat>();

function parts(iso: string, timeZone?: string): { d: string; m: string; y: string; hh: string; mm: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (!timeZone) {
    return { d: pad(date.getDate()), m: pad(date.getMonth() + 1), y: String(date.getFullYear()), hh: pad(date.getHours()), mm: pad(date.getMinutes()) };
  }
  let f = partsCache.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      return parts(iso);
    }
    partsCache.set(timeZone, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return { d: out.day ?? '', m: out.month ?? '', y: out.year ?? '', hh: out.hour ?? '', mm: out.minute ?? '' };
}

/** "14:32" */
export function fmtTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const p = parts(iso, timeZone);
  return p ? `${p.hh}:${p.mm}` : '';
}

/** "30/10/2026 14:32" */
export function fmtDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const p = parts(iso, timeZone);
  return p ? `${p.d}/${p.m}/${p.y} ${p.hh}:${p.mm}` : '';
}

/** "30/10/2026" */
export function fmtDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const p = parts(iso, timeZone);
  return p ? `${p.d}/${p.m}/${p.y}` : '';
}

/** "agora", "há 5 min", "há 1 h 05" */
export function fmtElapsed(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 24) return `há ${h} h ${pad(rest)}`;
  return `há ${Math.floor(h / 24)} d`;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Gera uma chave aleatória (letras, números, - e _) com `bytes` bytes de aleatoriedade. */
export function randomKey(bytes = 18): string {
  const buf = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** "2026-12-31" → "31/12/2026" (sem passar por fusos horários). */
export function dateText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Tamanho de um ficheiro: "12,3 MB" ou "850 KB" (nunca "0,0 MB" para ficheiros pequenos). */
export function sizeText(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
