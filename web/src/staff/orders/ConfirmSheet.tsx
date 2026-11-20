import { useLayoutEffect, useState, type ReactNode } from 'react';
import { errorText } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Sheet } from '../../ui/Sheet';

interface Props {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  /** Se falhar (lançar erro), a mensagem aparece na folha e pode tentar de novo. */
  onConfirm: () => Promise<void>;
}

/** Pede confirmação antes de uma ação que não se desfaz facilmente. */
export function ConfirmSheet({ open, title, children, confirmLabel, danger, onClose, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
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
          <Button variant={danger ? 'danger' : 'primary'} size="big" block loading={busy} onClick={() => void go()}>
            {confirmLabel}
          </Button>
          <Button variant="quiet" block onClick={onClose} disabled={busy}>
            Voltar
          </Button>
        </div>
      }
    >
      <div className="stack">
        {error ? (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        ) : null}
        <div>{children}</div>
      </div>
    </Sheet>
  );
}
