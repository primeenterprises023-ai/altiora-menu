import { useLayoutEffect, useState, type ReactNode } from 'react';
import { errorText } from '../../lib/api';
import { Button } from '../../ui/Button';
import { TextArea } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';

interface Props {
  open: boolean;
  title: string;
  description?: ReactNode;
  label?: string;
  placeholder?: string;
  confirmLabel: string;
  danger?: boolean;
  maxLength?: number;
  onClose: () => void;
  /** Se falhar (lançar erro), o motivo mantém-se e a mensagem aparece na folha. */
  onConfirm: (reason: string) => Promise<void>;
}

/** Pede um motivo (de pelo menos 3 letras) antes de uma ação que fica no histórico: cancelar, corrigir, reembolsar, isentar. */
export function ReasonSheet({ open, title, description, label = 'Motivo', placeholder, confirmLabel, danger, maxLength = 300, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    const text = reason.trim();
    if (text.length < 3) {
      setError('Escreva o motivo (pelo menos 3 letras).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(text);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={busy}
      title={title}
      footer={
        <div className="stack-sm">
          <Button variant={danger ? 'danger' : 'primary'} size="big" block loading={busy} onClick={() => void submit()}>
            {confirmLabel}
          </Button>
          <Button variant="quiet" block onClick={onClose} disabled={busy}>
            Voltar
          </Button>
        </div>
      }
    >
      <div className="stack">
        {description ? <div className="muted">{description}</div> : null}
        {error ? (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        ) : null}
        <TextArea label={label} placeholder={placeholder} rows={3} maxLength={maxLength} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </div>
    </Sheet>
  );
}
