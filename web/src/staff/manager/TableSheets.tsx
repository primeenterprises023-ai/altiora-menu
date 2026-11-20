// Folhas da página de mesas: criar/editar uma mesa, criar várias de uma vez e ver/guardar/renovar o QR Code.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StaffTable } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { copyText, saveBlob } from '../../lib/clipboard';
import { Link } from '../../lib/router';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch, TextField } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { tables as tablesApi } from '../data';
import { fieldErrors, listPt, nextTableNumber, parseTableNumber } from '../forms';
import { ConfirmSheet } from '../orders/ConfirmSheet';
import { QrImage, qrPngBlob, qrSvgFile } from './QrImage';

export const tableName = (t: Pick<StaffTable, 'table_number' | 'label'>) => (t.label ? `Mesa ${t.table_number} · ${t.label}` : `Mesa ${t.table_number}`);

// ---------------------------------------------------------------------------------------------------------------
// Criar ou editar uma mesa
// ---------------------------------------------------------------------------------------------------------------
interface FormProps {
  /** null = fechada; tableId null = mesa nova. */
  state: { tableId: string | null } | null;
  tables: StaffTable[];
  onClose: () => void;
  onSaved: (table: StaffTable, created: boolean) => void;
  onDeleted: (id: string) => void;
}

export function TableFormSheet({ state, tables, onClose, onSaved, onDeleted }: FormProps) {
  const toast = useToast();
  const table = state?.tableId ? tables.find((t) => t.id === state.tableId) : undefined;
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);

  const key = state ? (state.tableId ?? 'nova') : null;
  useLayoutEffect(() => {
    if (key === null) return;
    setNumber(table ? String(table.table_number) : String(nextTableNumber(tables)));
    setLabel(table?.label ?? '');
    setActive(table?.active ?? true);
    setBusy(false);
    setError(null);
    setErrors({});
    // só ao abrir (ou ao mudar de mesa)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!state) return null;
  const editing = !!table;

  const save = async () => {
    if (busy) return;
    setError(null);
    setErrors({});
    const text = label.trim();
    let n = table?.table_number ?? 0;
    if (!table) {
      const parsed = parseTableNumber(number);
      if (parsed === null) {
        setErrors({ table_number: 'Indique um número inteiro entre 1 e 9999.' });
        return;
      }
      if (tables.some((t) => t.table_number === parsed)) {
        setErrors({ table_number: `Já existe a mesa ${parsed}. Escolha outro número.` });
        return;
      }
      n = parsed;
    }
    setBusy(true);
    try {
      if (table) {
        const res = await tablesApi.update(table.id, { label: text || null, active });
        toast.show('Mesa guardada.');
        onSaved(res.table, false);
      } else {
        const res = await tablesApi.create({ table_number: n, label: text || null });
        toast.show(`Mesa ${n} criada.`);
        onSaved(res.table, true);
      }
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!table) return;
    await tablesApi.remove(table.id);
    toast.show(`Mesa ${table.table_number} apagada.`);
    setDeleting(false);
    onDeleted(table.id);
    onClose();
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        locked={busy}
        title={table ? `Editar a mesa ${table.table_number}` : 'Nova mesa'}
        footer={
          <div className="stack-sm">
            <Button size="big" block loading={busy} onClick={() => void save()}>
              {table ? 'Guardar' : 'Criar mesa'}
            </Button>
            {table ? (
              <Button variant="danger-quiet" block disabled={busy} onClick={() => setDeleting(true)}>
                Apagar mesa
              </Button>
            ) : null}
          </div>
        }
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {error && Object.keys(errors).length === 0 ? (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          ) : null}
          {editing ? (
            <p className="muted small">O número de uma mesa não se pode mudar, porque os pedidos antigos ficam ligados a ela. Se precisar de outra numeração, crie uma mesa nova.</p>
          ) : (
            <TextField
              label="Número da mesa"
              value={number}
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              error={errors.table_number}
              onChange={(e) => {
                setNumber(e.target.value.replace(/[^\d]/g, ''));
                setErrors((cur) => ({ ...cur, table_number: '' }));
              }}
            />
          )}
          <TextField
            label="Zona ou nome (opcional)"
            value={label}
            maxLength={60}
            autoComplete="off"
            placeholder="Ex.: Esplanada"
            hint="Aparece junto ao número, para o empregado saber onde fica a mesa."
            error={errors.label}
            onChange={(e) => {
              setLabel(e.target.value);
              setErrors((cur) => ({ ...cur, label: '' }));
            }}
          />
          {editing ? (
            <>
              <Switch checked={active} onChange={setActive} label="Mesa ativa (aceita pedidos por QR Code)" />
              {!active ? <p className="muted small">Enquanto estiver inativa, quem ler o QR Code desta mesa vê um aviso e não consegue fazer pedidos. Os empregados continuam a poder registar pedidos nela.</p> : null}
            </>
          ) : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </Sheet>
      <ConfirmSheet open={deleting} danger title="Apagar mesa" confirmLabel="Apagar mesa" onClose={() => setDeleting(false)} onConfirm={remove}>
        <p>
          Vai apagar a <strong>mesa {table?.table_number}</strong> e o respetivo QR Code deixa de funcionar. Só é possível se a mesa nunca teve pedidos; se já teve, desative-a (o histórico e os relatórios mantêm-se).
        </p>
      </ConfirmSheet>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Criar várias mesas de uma vez
// ---------------------------------------------------------------------------------------------------------------
const MAX_BULK = 60;

interface BulkProps {
  open: boolean;
  tables: StaffTable[];
  onClose: () => void;
  /** Chamado com as mesas que foram mesmo criadas (também se o processo parar a meio). */
  onDone: (created: StaffTable[]) => void;
}

export function BulkTablesSheet({ open, tables, onClose, onDone }: BulkProps) {
  const toast = useToast();
  const [count, setCount] = useState('10');
  const [start, setStart] = useState('1');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    setCount('10');
    setStart(String(nextTableNumber(tables)));
    setLabel('');
    setBusy(false);
    setProgress(0);
    setError(null);
    // só ao abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const n = /^\d{1,3}$/.test(count.trim()) ? Number(count.trim()) : null;
  const first = parseTableNumber(start);
  const plan = useMemo(() => {
    const problems: { count?: string; start?: string } = {};
    if (n === null || n < 1 || n > MAX_BULK) problems.count = `Indique um número de 1 a ${MAX_BULK}.`;
    if (first === null) problems.start = 'Indique um número inteiro entre 1 e 9999.';
    if (problems.count || problems.start || n === null || first === null) return { problems, numbers: [] as number[] };
    const numbers = Array.from({ length: n }, (_, i) => first + i);
    if (numbers[numbers.length - 1]! > 9999) problems.start = 'Os números não podem passar de 9999.';
    const taken = new Set(tables.map((t) => t.table_number));
    const clash = numbers.filter((x) => taken.has(x));
    if (clash.length > 0) {
      problems.start = `${clash.length === 1 ? 'Já existe a mesa' : 'Já existem as mesas'} ${listPt(clash.slice(0, 8))}${clash.length > 8 ? ' e outras' : ''}. Escolha outro primeiro número.`;
    }
    return { problems, numbers };
  }, [n, first, tables]);

  const ready = plan.numbers.length > 0 && !plan.problems.count && !plan.problems.start;

  const run = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    const made: StaffTable[] = [];
    const text = label.trim() || null;
    try {
      for (const num of plan.numbers) {
        const res = await tablesApi.create({ table_number: num, label: text });
        made.push(res.table);
        setProgress(made.length);
      }
      toast.show(made.length === 1 ? 'Mesa criada.' : `${made.length} mesas criadas.`);
      onDone(made);
      onClose();
    } catch (err) {
      if (made.length > 0) {
        onDone(made);
        // continuar de onde parou: o formulário passa a pedir só as que faltam
        setStart(String(plan.numbers[made.length]));
        setCount(String(plan.numbers.length - made.length));
        setError(`Foram criadas ${made.length} de ${plan.numbers.length} mesas. Parou na mesa ${plan.numbers[made.length]}: ${errorText(err)} Pode corrigir e tentar de novo para criar as que faltam.`);
      } else {
        setError(errorText(err));
      }
      setBusy(false);
    }
  };

  const summary =
    ready && first !== null
      ? plan.numbers.length === 1
        ? `Vai criar a mesa ${first}.`
        : `Vai criar ${plan.numbers.length} mesas, da ${first} à ${plan.numbers[plan.numbers.length - 1]}.`
      : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={busy}
      title="Criar várias mesas"
      footer={
        <Button size="big" block loading={busy} disabled={!ready} onClick={() => void run()}>
          {busy ? `A criar… ${progress} de ${plan.numbers.length}` : 'Criar mesas'}
        </Button>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {error ? (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        ) : null}
        <div className="field-row">
          <TextField label="Quantas mesas" value={count} inputMode="numeric" maxLength={3} autoComplete="off" error={plan.problems.count} onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ''))} />
          <TextField label="Primeiro número" value={start} inputMode="numeric" maxLength={4} autoComplete="off" error={plan.problems.start} onChange={(e) => setStart(e.target.value.replace(/[^\d]/g, ''))} />
        </div>
        <TextField
          label="Zona ou nome (opcional)"
          value={label}
          maxLength={60}
          autoComplete="off"
          placeholder="Ex.: Esplanada"
          hint="Fica igual em todas as mesas criadas agora. Pode mudar uma a uma depois."
          onChange={(e) => setLabel(e.target.value)}
        />
        {summary ? <p className="notice notice-info">{summary} Cada mesa recebe o seu próprio QR Code.</p> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Ver, guardar e renovar o QR Code
// ---------------------------------------------------------------------------------------------------------------
interface QrProps {
  table: StaffTable | null;
  onClose: () => void;
  onChanged: (table: StaffTable) => void;
}

export function QrSheet({ table, onClose, onChanged }: QrProps) {
  const toast = useToast();
  const field = useRef<HTMLInputElement>(null);
  const [renewing, setRenewing] = useState(false);
  const [saving, setSaving] = useState<'png' | 'svg' | null>(null);

  useLayoutEffect(() => {
    setRenewing(false);
    setSaving(null);
  }, [table?.id]);

  if (!table) return null;
  const url = table.qr_url;

  const copy = async () => {
    if (!url) return;
    const ok = await copyText(url, field.current);
    toast.show(ok ? 'Endereço copiado.' : 'Não foi possível copiar. Toque no endereço, selecione-o e copie.', ok ? 'info' : 'danger');
  };

  const save = async (kind: 'png' | 'svg') => {
    if (!url || saving) return;
    setSaving(kind);
    try {
      if (kind === 'png') saveBlob(await qrPngBlob(url), `qr-mesa-${table.table_number}.png`);
      else saveBlob(new Blob([qrSvgFile(url)], { type: 'image/svg+xml' }), `qr-mesa-${table.table_number}.svg`);
    } catch (err) {
      toast.show(errorText(err), 'danger');
    } finally {
      setSaving(null);
    }
  };

  const renew = async () => {
    const res = await tablesApi.regenerateQr(table.id);
    onChanged(res.table);
    setRenewing(false);
    toast.show('Novo QR Code gerado. Imprima-o e substitua o que está na mesa.');
  };

  return (
    <>
      <Sheet open onClose={onClose} title={`QR Code · mesa ${table.table_number}`}>
        {!url ? (
          <p className="notice notice-danger" role="alert">
            O QR Code desta mesa não está disponível. Tente atualizar a página.
          </p>
        ) : (
          <div className="stack-lg">
            <div className="qr-show">
              <div className="qr-frame">
                <QrImage url={url} label={`QR Code da mesa ${table.table_number}`} className="qr-big" />
              </div>
              <p className="qr-name voice">{tableName(table)}</p>
              {!table.active ? <Badge>Mesa inativa</Badge> : null}
            </div>

            {!table.active ? <p className="notice">Esta mesa está inativa: quem ler o QR Code vê um aviso e não consegue fazer pedidos. Ative-a em "Editar".</p> : null}

            <div className="field">
              <label className="label" htmlFor="qr-url">
                Endereço do menu desta mesa
              </label>
              <input id="qr-url" ref={field} className="input qr-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              <p className="hint">Quem tiver este endereço consegue fazer pedidos nesta mesa. Não o publique; use o QR Code impresso na mesa.</p>
            </div>

            <div className="qr-actions">
              <Button variant="secondary" onClick={() => void copy()}>
                Copiar endereço
              </Button>
              <Link className="btn btn-secondary" to={`/gerente/mesas/imprimir?mesa=${table.id}`} onClick={onClose}>
                Imprimir
              </Link>
              <Button variant="secondary" loading={saving === 'png'} disabled={saving !== null} onClick={() => void save('png')}>
                Guardar PNG
              </Button>
              <Button variant="secondary" loading={saving === 'svg'} disabled={saving !== null} onClick={() => void save('svg')}>
                Guardar SVG
              </Button>
            </div>
            <p className="muted small">PNG é uma imagem normal, para enviar por mensagem ou colar num documento. SVG é a versão para a gráfica: imprime-se nítida em qualquer tamanho.</p>

            <div className="sheet-section stack-sm">
              <h3 className="section-title">QR Code comprometido ou perdido?</h3>
              <p className="muted small">Se alguém fotografou o QR Code e o usa fora do restaurante, ou se o colou na mesa errada, gere um novo. O antigo deixa de funcionar de imediato.</p>
              <Button variant="danger-quiet" onClick={() => setRenewing(true)}>
                Gerar novo QR Code
              </Button>
            </div>
          </div>
        )}
      </Sheet>
      <ConfirmSheet open={renewing} danger title="Gerar novo QR Code" confirmLabel="Gerar novo QR Code" onClose={() => setRenewing(false)} onConfirm={renew}>
        <div className="stack-sm">
          <p>
            O QR Code atual da <strong>mesa {table.table_number}</strong> deixa de funcionar de imediato: quem o ler vê uma mensagem de erro. Os pedidos já feitos não são afetados.
          </p>
          <p>A mesa fica livre para o próximo cliente. Depois, imprima o novo QR Code e substitua o que está na mesa.</p>
        </div>
      </ConfirmSheet>
    </>
  );
}
