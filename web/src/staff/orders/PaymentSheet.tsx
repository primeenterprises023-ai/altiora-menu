import { useLayoutEffect, useState } from 'react';
import { METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from '../../../../shared/payments';
import { parseKzToCents } from '../../../../shared/money';
import type { OrderView } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { kz } from '../../lib/format';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/Fields';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { payments } from '../data';

/** Cêntimos como texto editável: 1232000 → "12320"; 450050 → "4500,50". */
export function centsToInput(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return frac ? `${whole},${String(frac).padStart(2, '0')}` : String(whole);
}

interface Props {
  order: OrderView | null;
  /** O que falta receber (a partir dos dados mais recentes). */
  dueCents: number;
  onClose: () => void;
  onRecorded: () => void;
}

/**
 * Registar que o restaurante RECEBEU dinheiro por este pedido. O sistema não cobra nada: só guarda o que a equipa confirma
 * (dinheiro, terminal de pagamento ou transferência), com quem registou e quando.
 */
export function PaymentSheet({ order, dueCents, onClose, onRecorded }: Props) {
  const toast = useToast();
  const [method, setMethod] = useState<PaymentMethod>('dinheiro');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [due, setDue] = useState(dueCents);

  useLayoutEffect(() => {
    if (order) {
      setMethod('dinheiro');
      setDue(dueCents);
      setAmount(centsToInput(dueCents));
      setReference('');
      setError(null);
      setBusy(false);
    }
    // só ao abrir para um pedido
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  if (!order) return null;
  const parsed = parseKzToCents(amount);
  const valid = parsed !== null && parsed > 0 && parsed <= due;

  const submit = async () => {
    if (busy) return;
    if (parsed === null || parsed <= 0) {
      setError('Indique um valor válido (ex.: 5000 ou 5 000,50).');
      return;
    }
    if (parsed > due) {
      setError(`O valor não pode ser superior ao que falta pagar (${kz(due)}).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await payments.record(order.id, { method, amount_cents: parsed, ...(reference.trim() ? { reference: reference.trim() } : {}) });
      toast.show(parsed === due ? 'Pagamento registado. Pedido pago.' : 'Pagamento parcial registado.');
      onRecorded();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AMOUNT_EXCEEDS_DUE') {
        const d = Number((err.details as { due_cents?: number } | undefined)?.due_cents);
        if (Number.isFinite(d)) {
          setDue(d);
          setAmount(centsToInput(d));
        }
        onRecorded();
      } else if (err instanceof ApiError && (err.code === 'NOTHING_DUE' || err.code === 'ORDER_EXEMPT' || err.code === 'ORDER_CANCELLED')) {
        onRecorded();
      }
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy}
      title={`Registar pagamento · Pedido #${order.order_number}`}
      footer={
        <div className="stack-sm">
          <Button size="big" block split loading={busy} disabled={!valid} onClick={() => void submit()}>
            <span>Registar pagamento</span>
            {parsed !== null && parsed > 0 ? <Money cents={parsed} /> : null}
          </Button>
          <Button variant="quiet" block onClick={onClose} disabled={busy}>
            Voltar
          </Button>
        </div>
      }
    >
      <div className="stack-lg">
        <div className="pay-summary">
          <div className="leader">
            <span className="lead">Total do pedido</span>
            <span className="fill" aria-hidden="true" />
            <Money className="tail" cents={order.total_cents} />
          </div>
          <div className="leader">
            <span className="lead">Falta receber</span>
            <span className="fill" aria-hidden="true" />
            <Money className="tail pay-due" cents={due} />
          </div>
        </div>

        {error ? (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        ) : null}

        <fieldset className="stack-sm">
          <legend className="label">Como foi pago</legend>
          <div className="choice-grid" role="radiogroup" aria-label="Como foi pago">
            {PAYMENT_METHODS.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={method === m} className="choice" onClick={() => setMethod(m)}>
                {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
        </fieldset>

        <TextField
          label="Valor recebido (Kz)"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint={parsed !== null && parsed > 0 && parsed < due ? 'Pagamento em parte: o resto continua por pagar.' : 'Já está preenchido com o que falta pagar.'}
        />
        <TextField label="Referência (opcional)" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} hint="Por exemplo, o número da transferência." />

        <p className="muted small">Só registe depois de ter recebido o valor. Fica guardado quem registou e quando.</p>
      </div>
    </Sheet>
  );
}
