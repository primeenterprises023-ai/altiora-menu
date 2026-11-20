// Horário de funcionamento: para cada dia, nenhum intervalo (fechado) ou até 3 intervalos (ex.: almoço e jantar).
import { WEEKDAYS, WEEKDAY_LABELS, type OpeningHours, type TimeRange, type Weekday } from '../../../../shared/hours';
import { Button } from '../../ui/Button';

interface Props {
  value: OpeningHours;
  onChange: (next: OpeningHours) => void;
  error?: string | null;
}

const MAX_RANGES = 3;
const DEFAULTS: TimeRange[] = [['08:00', '22:00'], ['18:00', '23:00'], ['20:00', '23:30']];

export function HoursEditor({ value, onChange, error }: Props) {
  const set = (day: Weekday, ranges: TimeRange[]) => {
    const next: OpeningHours = { ...value };
    if (ranges.length === 0) delete next[day];
    else next[day] = ranges;
    onChange(next);
  };
  const firstOpen = WEEKDAYS.find((d) => (value[d]?.length ?? 0) > 0);

  return (
    <div className="hours" role="group" aria-label="Horário de funcionamento">
      {WEEKDAYS.map((day) => {
        const ranges = value[day] ?? [];
        return (
          <div key={day} className="hours-day">
            <span className="hours-name">{WEEKDAY_LABELS[day]}</span>
            <div className="hours-ranges">
              {ranges.length === 0 ? <span className="muted">Fechado</span> : null}
              {ranges.map((r, i) => (
                <div key={i} className="hours-range">
                  <input
                    type="time"
                    className="input input-time"
                    aria-label={`${WEEKDAY_LABELS[day]}: abre às`}
                    value={r[0]}
                    onChange={(e) => set(day, ranges.map((x, k) => (k === i ? [e.target.value, x[1]] : x)))}
                  />
                  <span aria-hidden="true">–</span>
                  <input
                    type="time"
                    className="input input-time"
                    aria-label={`${WEEKDAY_LABELS[day]}: fecha às`}
                    value={r[1]}
                    onChange={(e) => set(day, ranges.map((x, k) => (k === i ? [x[0], e.target.value] : x)))}
                  />
                  <button type="button" className="icon-btn" aria-label={`Apagar este horário de ${WEEKDAY_LABELS[day]}`} onClick={() => set(day, ranges.filter((_, k) => k !== i))}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
            {ranges.length < MAX_RANGES ? (
              <Button variant="quiet" size="sm" onClick={() => set(day, [...ranges, DEFAULTS[ranges.length]!])}>
                {ranges.length === 0 ? 'Abrir' : '+ Horário'}
              </Button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      {firstOpen ? (
        <Button variant="secondary" size="sm" onClick={() => onChange(Object.fromEntries(WEEKDAYS.map((d) => [d, (value[firstOpen] ?? []).map((r) => [...r] as TimeRange)])) as OpeningHours)}>
          Copiar {WEEKDAY_LABELS[firstOpen].toLowerCase()} para todos os dias
        </Button>
      ) : null}
      <p className="hint">Se fecha depois da meia-noite, escreva a hora de fecho normalmente (por exemplo, das 18:00 às 02:00). Deixe «Fechado» nos dias sem serviço.</p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
