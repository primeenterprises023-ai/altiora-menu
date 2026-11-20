// «Chamar o garçom»: a única ação extra do cliente além de pedir. O empregado vê a chamada, com o número da mesa, no ecrã dele.
import { useEffect, useRef, useState } from 'react';
import type { WaiterCallPublic } from '../../../shared/types';
import { ApiError } from '../lib/api';
import { fmtTime } from '../lib/format';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { BellIcon } from './icons';
import { waiterApi } from './data';

interface Props {
  token: string;
  tableName: string;
  call: WaiterCallPublic | null;
  timezone: string;
  /** Pede ao ecrã que volte a ler o menu (para saber se a chamada já foi atendida). */
  onChanged: () => void;
}

export function WaiterCall({ token, tableName, call, timezone, onChanged }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hadCall = useRef<string | null>(null);
  const cancelledByMe = useRef(false);

  // enquanto há uma chamada em aberto, confirma de poucos em poucos segundos se já foi atendida
  useEffect(() => {
    if (!call) return;
    const id = window.setInterval(onChanged, 8000);
    return () => window.clearInterval(id);
  }, [call?.id, onChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (call) {
      hadCall.current = call.id;
      cancelledByMe.current = false;
    } else if (hadCall.current) {
      hadCall.current = null;
      if (!cancelledByMe.current) toast.show('O garçom atendeu a sua chamada.');
      setOpen(false);
    }
  }, [call, toast]);

  const describe = (err: unknown): string => {
    if (err instanceof ApiError && err.isNetwork) return 'Sem ligação. Tente outra vez ou acene a um empregado.';
    if (err instanceof ApiError) return err.message;
    return 'Não foi possível chamar o garçom. Tente outra vez ou acene a um empregado.';
  };

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      await waiterApi.call(token);
      onChanged();
      setOpen(false);
      toast.show('Chamámos o garçom. Já vem a caminho.');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    cancelledByMe.current = true;
    try {
      await waiterApi.cancel(token);
      onChanged();
      setOpen(false);
    } catch (err) {
      cancelledByMe.current = false;
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={`mn-call${call ? ' mn-call-on' : ''}`} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <BellIcon />
        <span>{call ? 'Garçom chamado' : 'Chamar o garçom'}</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} locked={busy} title={call ? 'Garçom chamado' : 'Chamar o garçom'}>
        <div className="stack">
          {call ? (
            <>
              <p>
                Chamámos o garçom à <strong>{tableName}</strong> às {fmtTime(call.created_at, timezone)}. Já vem a caminho.
              </p>
              <p className="hint">Se já não precisar, pode cancelar a chamada.</p>
              {error ? <p className="notice notice-danger" role="alert">{error}</p> : null}
              <Button variant="danger" block loading={busy} onClick={cancel}>
                Cancelar a chamada
              </Button>
              <Button variant="quiet" block onClick={() => setOpen(false)}>
                Fechar
              </Button>
            </>
          ) : (
            <>
              <p>
                Quer chamar o garçom à <strong>{tableName}</strong>? O empregado vê a sua mesa no ecrã e vem ter consigo.
              </p>
              {error ? <p className="notice notice-danger" role="alert">{error}</p> : null}
              <Button size="big" block loading={busy} onClick={make}>
                Chamar agora
              </Button>
              <Button variant="quiet" block onClick={() => setOpen(false)}>
                Agora não
              </Button>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
