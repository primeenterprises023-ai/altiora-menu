// Aviso fixo no topo da sala: as mesas que chamaram o garçom, com o tempo de espera e o botão «Atender».
import type { WaiterCallView } from '../../../../shared/types';
import { fmtElapsed } from '../../lib/format';
import { Button } from '../../ui/Button';

interface Props {
  calls: WaiterCallView[];
  now: number;
  skewMs: number;
  busy: ReadonlySet<string>;
  onAttend: (call: WaiterCallView) => void;
}

export const callTableName = (c: Pick<WaiterCallView, 'table_number' | 'table_label'>) => `Mesa ${c.table_number}${c.table_label ? ` · ${c.table_label}` : ''}`;

export function CallsBanner({ calls, now, skewMs, busy, onAttend }: Props) {
  if (calls.length === 0) return null;
  return (
    <section className="calls" aria-label="Mesas a chamar o garçom" aria-live="polite">
      <h2 className="calls-title">
        {calls.length === 1 ? '1 mesa a chamar' : `${calls.length} mesas a chamar`}
      </h2>
      <ul className="calls-list">
        {calls.map((c) => {
          const wait = now + skewMs - Date.parse(c.created_at);
          return (
            <li key={c.id} className={`call${wait > 3 * 60_000 ? ' call-late' : ''}`}>
              <span className="call-num voice" aria-hidden="true">{c.table_number}</span>
              <span className="call-info">
                <strong>{callTableName(c)}</strong>
                <span className="muted">{fmtElapsed(wait)}</span>
              </span>
              <Button size="sm" loading={busy.has(c.id)} onClick={() => onAttend(c)} aria-label={`Atender a ${callTableName(c)}`}>
                Atender
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
