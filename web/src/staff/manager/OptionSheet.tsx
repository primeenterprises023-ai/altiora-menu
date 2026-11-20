import { useLayoutEffect, useState } from 'react';
import { parseKzToCents } from '../../../../shared/money';
import type { StaffMenuItem } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Switch, TextField } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { menu as menuApi } from '../data';
import { fieldErrors, nextOrder } from '../forms';
import { ConfirmSheet } from '../orders/ConfirmSheet';
import { centsToInput } from '../orders/PaymentSheet';

export interface OptionState {
  itemId: string;
  /** null = novo. */
  optionId: string | null;
  kind: 'size' | 'extra';
}

interface Props {
  /** null = fechada; optionId null = opção nova. */
  state: OptionState | null;
  item: StaffMenuItem | undefined;
  onClose: () => void;
  onChanged: () => void;
}

/** Um extra (ex.: "Funge extra", +1 000 Kz) ou um tamanho (ex.: "Meia dose") de um prato. */
export function OptionSheet({ state, item, onClose, onChanged }: Props) {
  const toast = useToast();
  const option = state?.optionId ? item?.options.find((o) => o.id === state.optionId) : undefined;
  const [name, setName] = useState('');
  const [price, setPrice] = useState('0');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);

  const key = state ? `${state.itemId}:${state.optionId ?? `novo-${state.kind}`}` : null;
  useLayoutEffect(() => {
    if (key === null) return;
    setName(option?.name ?? '');
    setPrice(centsToInput(option?.price_delta_cents ?? 0));
    setActive(option?.active ?? true);
    setBusy(false);
    setError(null);
    setErrors({});
    // só ao abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!state || !item) return null;
  const size = (option?.kind ?? state.kind) === 'size';
  const noun = size ? 'tamanho' : 'extra';

  const save = async () => {
    if (busy) return;
    const cents = parseKzToCents(price);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = `Indique o nome do ${noun}.`;
    if (cents === null) next.price_delta_cents = `Indique um valor válido (ex.: 1000, ou 0 se ${size ? 'o preço for o do prato' : 'for grátis'}).`;
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      if (option) await menuApi.updateOption(option.id, { name: name.trim(), price_delta_cents: cents!, active });
      else await menuApi.createOption(item.id, { name: name.trim(), price_delta_cents: cents!, kind: state.kind, active, display_order: nextOrder(item.options) });
      toast.show(option ? `${size ? 'Tamanho guardado' : 'Extra guardado'}.` : `${size ? 'Tamanho adicionado' : 'Extra adicionado'}.`);
      onChanged();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!option) return;
    await menuApi.deleteOption(option.id);
    toast.show(`${size ? 'Tamanho apagado' : 'Extra apagado'}.`);
    setDeleting(false);
    onChanged();
    onClose();
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        locked={busy}
        title={option ? `Editar ${noun} · ${item.name}` : `Novo ${noun} · ${item.name}`}
        footer={
          <div className="stack-sm">
            <Button size="big" block loading={busy} onClick={() => void save()}>
              {option ? 'Guardar' : `Adicionar ${noun}`}
            </Button>
            {option ? (
              <Button variant="danger-quiet" block disabled={busy} onClick={() => setDeleting(true)}>
                Apagar {noun}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="stack">
          {error ? (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          ) : null}
          <TextField label={`Nome do ${noun}`} value={name} maxLength={80} error={errors.name} onChange={(e) => setName(e.target.value)} placeholder={size ? 'Ex.: Meia dose' : 'Ex.: Funge extra'} autoComplete="off" />
          <TextField
            label={size ? 'Acréscimo ao preço do prato (Kz)' : 'Valor a somar ao preço (Kz)'}
            value={price}
            inputMode="decimal"
            error={errors.price_delta_cents}
            onChange={(e) => setPrice(e.target.value)}
            hint={size ? 'Escreva 0 se este tamanho custa o preço do prato.' : 'Escreva 0 se o extra for grátis.'}
            autoComplete="off"
          />
          <Switch checked={active} onChange={setActive} label="Disponível para o cliente escolher" />
        </div>
      </Sheet>
      <ConfirmSheet open={deleting} danger title={`Apagar ${noun}`} confirmLabel={`Apagar ${noun}`} onClose={() => setDeleting(false)} onConfirm={remove}>
        <p>
          Vai apagar o {noun} <strong>{option?.name}</strong>. Os pedidos já feitos mantêm-no no histórico.
        </p>
      </ConfirmSheet>
    </>
  );
}
