// Mesas e QR Codes do gerente: criar mesas, ver e imprimir o QR Code de cada uma, renová-lo se for preciso.
import { useCallback, useMemo, useState } from 'react';
import type { StaffTable } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { useLive } from '../../lib/live';
import { Link } from '../../lib/router';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ConnectionPill } from '../../ui/Pill';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { tables as tablesApi } from '../data';
import { downloadFile } from '../download';
import { useFeatures } from '../features';
import { useDocumentTitle, useStaffStream } from '../hooks';
import { useRestaurant } from '../Shell';
import { QrImage } from './QrImage';
import { BulkTablesSheet, QrSheet, TableFormSheet } from './TableSheets';

type TablesData = { tables: StaffTable[] };
const byNumber = (a: StaffTable, b: StaffTable) => a.table_number - b.table_number;

/** Os QR Codes só servem se apontarem para um endereço que os clientes consigam abrir. */
function brokenBase(tables: StaffTable[]): string | null {
  const first = tables.find((t) => t.qr_url)?.qr_url;
  if (!first) return null;
  try {
    const host = new URL(first).hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
    const here = window.location.hostname;
    const hereLocal = here === 'localhost' || here === '127.0.0.1' || here === '::1';
    return local && !hereLocal ? new URL(first).origin : null;
  } catch {
    return null;
  }
}

/** Descarrega um PDF; se o plano ou a ligação falharem, diz porquê (nunca fica um ficheiro estragado). */
function usePdf() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const get = async (key: string, path: string, name: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await downloadFile(path, name);
      toast.show('PDF pronto. Procure-o nas transferências do aparelho.');
    } catch (err) {
      toast.show(errorText(err), 'danger');
    } finally {
      setBusy(null);
    }
  };
  return { busy, get };
}

/** O QR Code do restaurante: abre o menu completo (sem mesa). Serve para a porta, o balcão e as redes sociais. */
function RestaurantQrCard({ slug }: { slug: string }) {
  const pdf = usePdf();
  return (
    <section className="settings-block stack-sm" aria-labelledby="qr-rest">
      <h2 className="section-title" id="qr-rest">
        QR Code do restaurante
      </h2>
      <p className="muted small">Abre o menu completo, sem identificar a mesa (não se faz pedido por aqui). Ideal para a porta, o balcão, cartões e redes sociais.</p>
      <div className="toolbar">
        <Button loading={pdf.busy === 'restaurant'} onClick={() => void pdf.get('restaurant', '/api/qr/restaurant.pdf', 'qr-restaurante.pdf')}>
          Descarregar PDF
        </Button>
        <a className="btn btn-secondary" href={`/r/${slug}`} target="_blank" rel="noopener">
          Ver a página do menu
        </a>
      </div>
    </section>
  );
}

export default function TablesPage() {
  const stream = useStaffStream();
  const features = useFeatures();
  const { restaurant } = useRestaurant();
  const pdf = usePdf();
  const hasTables = features.has('tables');
  const live = useLive<TablesData>((signal) => tablesApi.list(signal), { stream, pollMs: 20_000, safetyMs: 90_000, enabled: hasTables });
  const { refresh, mutate } = live;
  const [form, setForm] = useState<{ tableId: string | null } | null>(null);
  const [bulk, setBulk] = useState(false);
  const [qrId, setQrId] = useState<string | null>(null);
  useDocumentTitle('Mesas e QR Codes');

  const tables = useMemo(() => [...(live.data?.tables ?? [])].sort(byNumber), [live.data]);
  const inactive = tables.filter((t) => !t.active).length;
  const qrTable = qrId ? (tables.find((t) => t.id === qrId) ?? null) : null;
  const bad = brokenBase(tables);

  const upsert = useCallback(
    (table: StaffTable) => {
      mutate((cur) => {
        const rest = (cur?.tables ?? []).filter((t) => t.id !== table.id);
        // a resposta de gravar não traz as contagens de pedidos: mantém as que já tínhamos
        const old = (cur?.tables ?? []).find((t) => t.id === table.id);
        return { tables: [...rest, old ? { ...table, active_orders: old.active_orders, ready_orders: old.ready_orders } : table] };
      });
    },
    [mutate],
  );

  const onSaved = (table: StaffTable, created: boolean) => {
    upsert(table);
    // uma mesa nova acabou de ser criada: o gerente quer logo ver o QR Code dela
    if (created) setQrId(table.id);
    refresh();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Mesas e QR Codes</h1>
          <ConnectionPill live={live.live} error={live.error} />
        </div>
        {hasTables ? (
          <div className="toolbar">
            <Button onClick={() => setForm({ tableId: null })}>Nova mesa</Button>
            <Button variant="secondary" onClick={() => setBulk(true)}>
              Criar várias
            </Button>
          </div>
        ) : null}
      </div>

      {features.has('qr_codes') && restaurant ? <RestaurantQrCard slug={restaurant.slug} /> : null}

      {!hasTables ? (
        <div className="notice" role="note">
          <strong>QR Codes por mesa não estão incluídos no seu plano.</strong> Com eles, cada mesa tem o seu QR Code e o pedido chega à cozinha já com o número da mesa.{' '}
          <Link to="/gerente/plano">Ver o plano</Link>
        </div>
      ) : null}

      {hasTables ? (
      <p className="muted">
        Cada mesa tem o seu QR Code. Imprima-o e coloque-o na mesa: o cliente aponta a câmara do telemóvel, vê o menu e faz o pedido, sem instalar nada.
      </p>
      ) : null}

      <StaleNotice error={live.data ? live.error : null} />

      {bad ? (
        <div className="notice notice-danger" role="alert">
          <strong>Atenção: estes QR Codes ainda não servem para os clientes.</strong> Apontam para <code>{bad}</code>, que só funciona no computador onde foi instalado. Defina o
          endereço público do restaurante antes de imprimir (peça ajuda à Altiora Grupo se precisar).
        </div>
      ) : null}

      {!hasTables ? null : live.loading ? (
        <Loading rows={5} />
      ) : live.error && !live.data ? (
        <ErrorState error={live.error} onRetry={refresh} />
      ) : tables.length === 0 ? (
        <EmptyState title="Ainda não tem mesas.">
          Crie as mesas do restaurante e imprima o QR Code de cada uma.
          <br />
          <span className="empty-actions">
            <Button className="mt" onClick={() => setForm({ tableId: null })}>
              Criar a primeira mesa
            </Button>
            <Button className="mt" variant="secondary" onClick={() => setBulk(true)}>
              Criar várias de uma vez
            </Button>
          </span>
        </EmptyState>
      ) : (
        <>
          <div className="split-head">
            <p className="small muted" aria-live="polite">
              {tables.length === 1 ? '1 mesa' : `${tables.length} mesas`}
              {inactive > 0 ? ` · ${inactive === 1 ? '1 inativa' : `${inactive} inativas`}` : ''}
            </p>
            <span className="toolbar">
              <Button size="sm" variant="secondary" loading={pdf.busy === 'tables'} onClick={() => void pdf.get('tables', '/api/qr/tables.pdf', 'qr-mesas.pdf')}>
                Descarregar PDF
              </Button>
              <Link className="btn btn-secondary btn-sm" to="/gerente/mesas/imprimir">
                Imprimir daqui
              </Link>
            </span>
          </div>
          <ul className="table-admin-grid">
            {tables.map((t) => (
              <li key={t.id} className={`table-admin${t.active ? '' : ' is-off'}`}>
                <button type="button" className="table-admin-open" aria-label={`Mesa ${t.table_number}${t.label ? `, ${t.label}` : ''}: ver o QR Code`} onClick={() => setQrId(t.id)}>
                  {t.qr_url ? <QrImage url={t.qr_url} label="" decorative className="table-admin-qr" /> : <span className="table-admin-qr" aria-hidden="true" />}
                  <span className="table-admin-text">
                    <span className="table-admin-num">Mesa {t.table_number}</span>
                    {t.label ? <span className="table-admin-label muted small">{t.label}</span> : null}
                    <span className="table-admin-tags">
                      {!t.active ? <Badge>Inativa</Badge> : null}
                      {t.ready_orders > 0 ? <Badge tone="ok">{t.ready_orders === 1 ? '1 pronto' : `${t.ready_orders} prontos`}</Badge> : null}
                      {t.active_orders > t.ready_orders ? <Badge tone="warn">{t.active_orders - t.ready_orders === 1 ? '1 em curso' : `${t.active_orders - t.ready_orders} em curso`}</Badge> : null}
                    </span>
                  </span>
                </button>
                <Button size="sm" variant="secondary" aria-label={`Editar a mesa ${t.table_number}`} onClick={() => setForm({ tableId: t.id })}>
                  Editar
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      <TableFormSheet
        state={form}
        tables={tables}
        onClose={() => setForm(null)}
        onSaved={onSaved}
        onDeleted={(id) => {
          mutate((cur) => (cur ? { tables: cur.tables.filter((t) => t.id !== id) } : cur));
          refresh();
        }}
      />
      <BulkTablesSheet
        open={bulk}
        tables={tables}
        onClose={() => setBulk(false)}
        onDone={(created) => {
          created.forEach(upsert);
          refresh();
        }}
      />
      <QrSheet
        table={qrTable}
        onClose={() => setQrId(null)}
        onChanged={(t) => {
          upsert(t);
          refresh();
        }}
      />
    </div>
  );
}
