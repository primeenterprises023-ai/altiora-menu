// Folha para imprimir os QR Codes: 6 por folha A4, com linhas tracejadas para recortar e colar nas mesas.
// No ecrã mostra uma pré-visualização; ao imprimir, só as folhas aparecem (o resto da página fica escondido).
import { useMemo, useState } from 'react';
import type { StaffTable } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { useLive } from '../../lib/live';
import { Link, useLocation } from '../../lib/router';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState, Loading } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { tables as tablesApi } from '../data';
import { useDocumentTitle } from '../hooks';
import { useRestaurant } from '../Shell';
import { QrImage } from './QrImage';
import { tableName } from './TableSheets';

const PER_PAGE = 6;
type TablesData = { tables: StaffTable[] };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function QrCard({ table, restaurantName }: { table: StaffTable & { qr_url: string }; restaurantName: string }) {
  return (
    <article className="qr-card" aria-label={`QR Code da mesa ${table.table_number}`}>
      {restaurantName ? <p className="qr-card-name">{restaurantName}</p> : null}
      <p className="qr-card-table">Mesa {table.table_number}</p>
      {table.label ? <p className="qr-card-zone">{table.label}</p> : null}
      <QrImage url={table.qr_url} label={`QR Code da mesa ${table.table_number}`} className="qr-card-img" />
      <p className="qr-card-help">Aponte a câmara do telemóvel para ver o menu e fazer o pedido.</p>
      <p className="qr-card-host">{hostOf(table.qr_url)}</p>
    </article>
  );
}

export default function QrPrintPage() {
  const toast = useToast();
  const { restaurant } = useRestaurant();
  const { params } = useLocation();
  const only = params.get('mesa');
  const live = useLive<TablesData>((signal) => tablesApi.list(signal), { pollMs: 60_000, safetyMs: 300_000 });
  const { mutate, refresh } = live;
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [checking, setChecking] = useState(false);
  useDocumentTitle('Imprimir QR Codes');

  const all = useMemo(() => [...(live.data?.tables ?? [])].filter((t): t is StaffTable & { qr_url: string } => !!t.qr_url).sort((a, b) => a.table_number - b.table_number), [live.data]);
  const wanted = only ? all.find((t) => t.id === only) : undefined;
  const defaults = useMemo(() => new Set((only ? all.filter((t) => t.id === only) : all.filter((t) => t.active)).map((t) => t.id)), [all, only]);
  const chosen = picked ?? defaults;
  const selected = all.filter((t) => chosen.has(t.id));
  const pages = useMemo(() => {
    const out: Array<typeof selected> = [];
    for (let i = 0; i < selected.length; i += PER_PAGE) out.push(selected.slice(i, i + PER_PAGE));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.map((t) => t.id).join(',')]);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  /** Antes de imprimir, confirma que os QR Codes ainda são os atuais: imprimir um QR Code já renovado seria um desperdício. */
  const print = async () => {
    if (checking || selected.length === 0) return;
    setChecking(true);
    try {
      const fresh = await tablesApi.list();
      const now = new Map(fresh.tables.map((t) => [t.id, t.qr_url]));
      const changed = selected.some((t) => now.get(t.id) !== t.qr_url);
      mutate(() => fresh);
      if (changed) {
        toast.show('Alguns QR Codes foram renovados entretanto. Confira a página e imprima de novo.', 'danger');
        return;
      }
    } catch (err) {
      toast.show(`Não foi possível confirmar que os QR Codes estão atualizados. ${errorText(err)}`, 'danger');
      return;
    } finally {
      setChecking(false);
    }
    window.print();
  };

  const name = restaurant?.name ?? '';

  return (
    <div className="page qr-print">
      <div className="page-head no-print">
        <div>
          <h1 className="page-title voice">Imprimir QR Codes</h1>
        </div>
        <div className="toolbar">
          <Link className="btn btn-quiet" to="/gerente/mesas">
            Voltar às mesas
          </Link>
          <Button disabled={selected.length === 0} loading={checking} onClick={() => void print()}>
            Imprimir{selected.length > 0 ? ` (${selected.length})` : ''}
          </Button>
        </div>
      </div>

      {live.loading ? (
        <Loading rows={4} />
      ) : live.error && !live.data ? (
        <ErrorState error={live.error} onRetry={refresh} />
      ) : all.length === 0 ? (
        <EmptyState title="Ainda não tem mesas.">
          Crie as mesas primeiro; depois volte aqui para imprimir os QR Codes.
          <br />
          <Link className="btn mt" to="/gerente/mesas">
            Ir para as mesas
          </Link>
        </EmptyState>
      ) : (
        <>
          <div className="no-print stack">
            {only && !wanted ? (
              <p className="notice" role="alert">
                Essa mesa já não existe. Escolha abaixo as mesas a imprimir.
              </p>
            ) : null}
            <p className="muted">
              Cada folha A4 leva 6 QR Codes. Recorte pelas linhas tracejadas e cole um em cada mesa (de preferência protegido com película). Na janela de impressão escolha
              papel A4, escala 100% e desligue "Cabeçalhos e rodapés".
            </p>
            <fieldset className="qr-picker">
              <div className="qr-picker-head">
                <legend className="label">Mesas a imprimir</legend>
                <span className="qr-picker-all">
                  <Button size="sm" variant="quiet" onClick={() => setPicked(new Set(all.map((t) => t.id)))}>
                    Todas
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setPicked(new Set())}>
                    Nenhuma
                  </Button>
                </span>
              </div>
              <div className="qr-picker-grid">
                {all.map((t) => (
                  <label key={t.id} className="check-row">
                    <input type="checkbox" checked={chosen.has(t.id)} onChange={() => toggle(t.id)} />
                    <span className="check-label">
                      {tableName(t)}
                      {!t.active ? ' (inativa)' : ''}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          {selected.length === 0 ? (
            <p className="notice no-print">Escolha pelo menos uma mesa para ver a pré-visualização.</p>
          ) : (
            <div className="qr-sheets">
              {pages.map((group, i) => (
                <section key={i} className="qr-page" aria-label={`Folha ${i + 1} de ${pages.length}`}>
                  <p className="qr-page-label no-print">
                    Folha {i + 1} de {pages.length}
                  </p>
                  {group.map((t) => (
                    <QrCard key={t.id} table={t} restaurantName={name} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
