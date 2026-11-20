// Relatórios do gerente. Dois números que NÃO se confundem:
//   Vendas registadas     = pedidos feitos no período (sem cancelados). Não é dinheiro recebido.
//   Pagamentos confirmados = dinheiro que a equipa registou como recebido (pela data do registo).
// Os dias contam-se no fuso horário do restaurante e os valores estão na moeda do restaurante.
import { useMemo, useState, type CSSProperties } from 'react';
import { METHOD_LABEL } from '../../../../shared/payments';
import type { SalesReport } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { fmtTime, kz, plural } from '../../lib/format';
import { Link } from '../../lib/router';
import { useLive } from '../../lib/live';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/Fields';
import { ErrorState, Loading, StaleNotice } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { reports as reportsApi } from '../data';
import { downloadFile } from '../download';
import { useFeatures } from '../features';
import { useDocumentTitle } from '../hooks';
import { useRestaurant } from '../Shell';

// ---- datas (no fuso do restaurante) --------------------------------------------------------------------------
const MS_DAY = 86_400_000;
const MAX_DAYS = 366;
const pad2 = (n: number) => String(n).padStart(2, '0');
const isIsoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_DAY);
const addDays = (iso: string, n: number) => {
  const d = new Date((dayNum(iso) + n) * MS_DAY);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dayLabel = (iso: string) => `${WEEKDAY[new Date(dayNum(iso) * MS_DAY).getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const longDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** A data de hoje (AAAA-MM-DD) no fuso horário do restaurante. */
function todayIn(timeZone: string | undefined): string {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const o: Record<string, string> = {};
    for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
    return `${o.year}-${o.month}-${o.day}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
}

type Preset = 'hoje' | 'ontem' | '7' | '30' | 'mes' | 'datas';
const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'hoje', label: 'Hoje' },
  { id: 'ontem', label: 'Ontem' },
  { id: '7', label: '7 dias' },
  { id: '30', label: '30 dias' },
  { id: 'mes', label: 'Este mês' },
  { id: 'datas', label: 'Escolher datas' },
];

function rangeFor(preset: Preset, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  switch (preset) {
    case 'hoje':
      return { from: today, to: today };
    case 'ontem': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case '7':
      return { from: addDays(today, -6), to: today };
    case '30':
      return { from: addDays(today, -29), to: today };
    case 'mes':
      return { from: `${today.slice(0, 8)}01`, to: today };
    default:
      return custom;
  }
}

/** Um período personalizado só serve se as duas datas existirem, estiverem por ordem e não forem demasiado longas. */
function rangeProblem(r: { from: string; to: string }): string | null {
  if (!isIsoDay(r.from) || !isIsoDay(r.to)) return 'Escolha a data inicial e a data final.';
  if (dayNum(r.from) > dayNum(r.to)) return 'A data inicial não pode ser depois da final.';
  if (dayNum(r.to) - dayNum(r.from) + 1 > MAX_DAYS) return `O período não pode ter mais de ${MAX_DAYS} dias.`;
  return null;
}

// ---- peças ---------------------------------------------------------------------------------------------------
function Kpi({ tone, label, value, sub }: { tone: 'sales' | 'paid' | 'due' | 'cancel'; label: string; value: string; sub: string[] }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {sub.map((line) => (
        <p key={line} className="kpi-sub">
          {line}
        </p>
      ))}
    </div>
  );
}

const pct = (value: number, max: number) => (max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0);
const bar = (value: number, max: number) => ({ '--pct': `${value > 0 ? pct(value, max) : 0}%` }) as CSSProperties;

export default function ReportsPage() {
  const { restaurant } = useRestaurant();
  const timezone = restaurant?.timezone;
  const today = useMemo(() => todayIn(timezone), [timezone]);
  const [preset, setPreset] = useState<Preset>('7');
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  useDocumentTitle('Relatórios');

  const range = rangeFor(preset, today, custom);
  const problem = preset === 'datas' ? rangeProblem(range) : null;
  const live = useLive<SalesReport>((signal) => reportsApi.sales(range.from, range.to, signal).then((r) => r.report), {
    pollMs: 60_000,
    safetyMs: 120_000,
    enabled: !problem,
    resetKey: `${range.from}|${range.to}`,
  });
  const r = problem ? undefined : live.data;

  const maxDay = r ? Math.max(0, ...r.by_day.map((d) => Math.max(d.total_cents, d.confirmed_cents))) : 0;
  const maxQty = r ? Math.max(0, ...r.top_items.map((i) => i.quantity)) : 0;
  const days = r ? [...r.by_day].reverse() : [];

  // o CSV só existe com "Gestão avançada" no plano: o servidor recusa sem ele, o botão só evita tentativas inúteis
  const canExport = useFeatures().has('advanced_management');
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const download = async () => {
    if (!r || exporting) return;
    setExporting(true);
    try {
      await downloadFile(reportsApi.csvPath(r.range.from, r.range.to), `vendas-${r.range.from}_a_${r.range.to}.csv`);
      toast.show('Ficheiro CSV pronto. Procure-o nas transferências do aparelho.');
    } catch (err) {
      toast.show(errorText(err), 'danger');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Relatórios</h1>
        </div>
      </div>

      <div className="stack">
        <div className="chips" role="group" aria-label="Período">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="chip" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'datas' ? (
          <div className="field-row">
            <TextField label="De" type="date" value={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <TextField label="Até" type="date" value={custom.to} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        ) : null}
        {problem ? (
          <p className="notice" role="alert">
            {problem}
          </p>
        ) : (
          <p className="muted small">
            {range.from === range.to ? `Dia ${longDate(range.from)}` : `De ${longDate(range.from)} a ${longDate(range.to)}`}
            {timezone ? ` · hora de ${timezone.replace('_', ' ')}` : ''}
            {live.updatedAt ? ` · atualizado às ${fmtTime(new Date(live.updatedAt).toISOString(), timezone)}` : ''}
          </p>
        )}
      </div>

      {problem ? null : <StaleNotice error={r ? live.error : null} />}

      {problem ? null : live.loading || (!r && !live.error) ? (
        <Loading rows={4} />
      ) : !r ? (
        <ErrorState error={live.error!} onRetry={live.refresh} />
      ) : (
        <>
          <div className="kpi-grid">
            <Kpi
              tone="sales"
              label="Vendas registadas"
              value={kz(r.sales.total_cents)}
              sub={[
                `${plural(r.sales.orders, 'pedido', 'pedidos')}${r.sales.orders > 0 ? ` · média ${kz(r.sales.average_ticket_cents)}` : ''}`,
                ...(r.sales.service_fee_cents > 0 ? [`Inclui ${kz(r.sales.service_fee_cents)} de serviço`] : []),
              ]}
            />
            <Kpi
              tone="paid"
              label="Pagamentos confirmados"
              value={kz(r.payments.confirmed_cents)}
              sub={['Dinheiro já recebido', ...(r.payments.refunded_cents > 0 ? [`Reembolsado: ${kz(r.payments.refunded_cents)}`] : [])]}
            />
            <Kpi
              tone="due"
              label="Por receber"
              value={kz(r.outstanding_cents)}
              sub={['Dos pedidos deste período', ...(r.exempt_orders > 0 ? [`${plural(r.exempt_orders, 'pedido isento', 'pedidos isentos')} (cortesia)`] : [])]}
            />
            <Kpi
              tone="cancel"
              label="Cancelados"
              value={plural(r.cancelled.orders, 'pedido', 'pedidos')}
              sub={[r.cancelled.orders > 0 ? `${kz(r.cancelled.total_cents)} fora das vendas` : 'Nenhum cancelamento']}
            />
          </div>

          <p className="notice notice-info">
            <strong>Vendas registadas</strong> são os pedidos feitos neste período (sem os cancelados): não é dinheiro recebido. <strong>Pagamentos confirmados</strong> é o dinheiro que a
            equipa registou como recebido nestes dias, mesmo que seja de pedidos de outros dias. Por isso os dois valores podem não ser iguais.
          </p>

          {r.sales.orders === 0 && r.payments.confirmed_cents === 0 ? (
            <div className="state">
              <p className="state-title">Sem movimento neste período.</p>
              <p className="muted">Não houve pedidos nem pagamentos registados entre estas datas.</p>
            </div>
          ) : (
            <>
              <div className="report-cols">
                <section className="stack" aria-labelledby="rp-methods">
                  <h2 className="section-title" id="rp-methods">
                    Pagamentos por método
                  </h2>
                  {r.payments.by_method.length === 0 ? (
                    <p className="muted small">Ainda não há pagamentos registados neste período.</p>
                  ) : (
                    <table className="rtable">
                      <caption className="sr-only">Pagamentos confirmados por método</caption>
                      <thead>
                        <tr>
                          <th scope="col">Método</th>
                          <th scope="col" className="num">
                            Pagamentos
                          </th>
                          <th scope="col" className="num">
                            Valor
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.payments.by_method.map((m) => (
                          <tr key={m.method}>
                            <th scope="row">{METHOD_LABEL[m.method] ?? m.method}</th>
                            <td className="num">{m.count}</td>
                            <td className="num">{kz(m.confirmed_cents)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th scope="row">Total</th>
                          <td className="num">{r.payments.by_method.reduce((n, m) => n + m.count, 0)}</td>
                          <td className="num">{kz(r.payments.confirmed_cents)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  )}
                </section>

                <section className="stack" aria-labelledby="rp-top">
                  <h2 className="section-title" id="rp-top">
                    Mais vendidos
                  </h2>
                  {r.top_items.length === 0 ? (
                    <p className="muted small">Sem pratos vendidos neste período.</p>
                  ) : (
                    <ol className="rank">
                      {r.top_items.map((i, n) => (
                        <li key={`${i.name}-${n}`} className="rank-row" style={bar(i.quantity, maxQty)}>
                          <span className="rank-n" aria-hidden="true">
                            {n + 1}
                          </span>
                          <span className="rank-name">{i.name}</span>
                          <span className="rank-qty">{i.quantity}×</span>
                          <span className="rank-total">{kz(i.total_cents)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>

              <section className="stack" aria-labelledby="rp-days">
                <div className="split-head">
                  <h2 className="section-title" id="rp-days">
                    Dia a dia
                  </h2>
                  {canExport ? (
                    <Button size="sm" variant="secondary" loading={exporting} onClick={() => void download()}>
                      Exportar CSV
                    </Button>
                  ) : (
                    <Link className="btn btn-quiet btn-sm" to="/gerente/plano" title="A exportação de relatórios em CSV faz parte da Gestão avançada">
                      Exportar CSV: não incluído no plano
                    </Link>
                  )}
                </div>
                <table className="rtable rtable-days">
                  <caption className="sr-only">Pedidos, vendas registadas e pagamentos confirmados por dia</caption>
                  <thead>
                    <tr>
                      <th scope="col">Dia</th>
                      <th scope="col" className="num">
                        Pedidos
                      </th>
                      <th scope="col" className="num">
                        Vendas
                      </th>
                      <th scope="col" className="num">
                        Recebido
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.day} className={d.orders === 0 && d.confirmed_cents === 0 ? 'is-empty' : undefined}>
                        <th scope="row">{dayLabel(d.day)}</th>
                        <td className="num">{d.orders}</td>
                        <td className="num has-bar" style={bar(d.total_cents, maxDay)}>
                          {kz(d.total_cents)}
                        </td>
                        <td className="num">{kz(d.confirmed_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td className="num">{r.sales.orders}</td>
                      <td className="num">{kz(r.sales.total_cents)}</td>
                      <td className="num">{kz(r.payments.confirmed_cents)}</td>
                    </tr>
                  </tfoot>
                </table>
                <p className="muted small">
                  As vendas contam-se pelo dia do pedido; os pagamentos, pelo dia em que foram registados. Valores em Kwanzas (Kz).
                </p>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
