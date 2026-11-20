// Horário de funcionamento: guardado como {"mon": [["12:00","15:00"], ["19:00","23:00"]], ...} na hora local do restaurante.
// Um intervalo cujo fim é igual ou anterior ao início passa da meia-noite (ex.: 18:00–02:00).
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type TimeRange = [string, string];
export type OpeningHours = Partial<Record<Weekday, TimeRange[]>>;

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Segunda-feira',
  tue: 'Terça-feira',
  wed: 'Quarta-feira',
  thu: 'Quinta-feira',
  fri: 'Sexta-feira',
  sat: 'Sábado',
  sun: 'Domingo',
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTime = (v: unknown): v is string => typeof v === 'string' && TIME.test(v);
const minutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Lê o que veio da base de dados ou do formulário e devolve só intervalos válidos (no máximo 3 por dia). */
export function parseHours(value: unknown): OpeningHours {
  const out: OpeningHours = {};
  if (!value || typeof value !== 'object') return out;
  for (const day of WEEKDAYS) {
    const raw = (value as Record<string, unknown>)[day];
    if (!Array.isArray(raw)) continue;
    const ranges: TimeRange[] = [];
    for (const r of raw.slice(0, 3)) {
      if (Array.isArray(r) && isTime(r[0]) && isTime(r[1]) && r[0] !== r[1]) ranges.push([r[0], r[1]]);
    }
    if (ranges.length) out[day] = ranges;
  }
  return out;
}

export const hasHours = (h: OpeningHours): boolean => WEEKDAYS.some((d) => (h[d]?.length ?? 0) > 0);

/** "12:00–15:00 · 19:00–23:00" ou "Fechado". */
export const dayText = (ranges: TimeRange[] | undefined): string => (ranges?.length ? ranges.map(([a, b]) => `${a}–${b}`).join(' · ') : 'Fechado');

/** Dia da semana e minutos desde a meia-noite, na hora do fuso indicado. */
function localParts(now: Date, timeZone: string): { day: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { day: day < 0 ? 0 : day, min: Number(get('hour')) * 60 + Number(get('minute')) };
}

export interface OpeningStatus {
  /** null = o restaurante não indicou horário. */
  open: boolean | null;
  label: string;
}

/** Aberto agora? Devolve também a frase pronta a mostrar ("Aberto agora · fecha às 23:00"). */
export function openingStatus(hours: OpeningHours, timeZone: string, now: Date = new Date()): OpeningStatus {
  if (!hasHours(hours)) return { open: null, label: '' };
  let cur: { day: number; min: number };
  try {
    cur = localParts(now, timeZone);
  } catch {
    cur = localParts(now, 'Africa/Luanda');
  }
  // 1) estamos dentro de um intervalo de hoje, ou de um que começou ontem e passa da meia-noite?
  for (const [offset, d] of [[0, cur.day], [-1, (cur.day + 6) % 7]] as const) {
    for (const [a, b] of hours[WEEKDAYS[d]!] ?? []) {
      const start = minutes(a);
      const end = minutes(b);
      const crosses = end <= start;
      const inside = offset === 0 ? (crosses ? cur.min >= start : cur.min >= start && cur.min < end) : crosses && cur.min < end;
      if (inside) return { open: true, label: `Aberto agora · fecha às ${b}` };
    }
  }
  // 2) fechado: procura a próxima abertura nos próximos 7 dias
  for (let i = 0; i < 8; i++) {
    const d = (cur.day + i) % 7;
    const starts = (hours[WEEKDAYS[d]!] ?? []).map(([a]) => minutes(a)).sort((x, y) => x - y);
    const next = starts.find((s) => i > 0 || s > cur.min);
    if (next !== undefined) {
      const hh = `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
      const when = i === 0 ? 'hoje' : i === 1 ? 'amanhã' : WEEKDAY_LABELS[WEEKDAYS[d]!].toLowerCase();
      return { open: false, label: `Fechado · abre ${when} às ${hh}` };
    }
  }
  return { open: false, label: 'Fechado' };
}
