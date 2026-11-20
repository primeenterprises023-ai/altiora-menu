import { useLayoutEffect, useRef, useState } from 'react';
import { kz, plural, randomKey } from '../lib/format';
import { ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Stepper, TextArea } from '../ui/Fields';
import { Money } from '../ui/Money';
import { Sheet } from '../ui/Sheet';
import { MAX_LINE_QUANTITY, MAX_UNITS, cartSubtotal, cartUnits, feeFor, feeLabel, lineTotal, toPayload, type CartLine } from './cart';
import { publicApi } from './data';
import { whatsappText, whatsappUrl } from './whatsapp';
import type { PublicOrderView } from '../../../shared/types';

interface Props {
  open: boolean;
  onClose: () => void;
  token: string;
  /** null = menu aberto sem QR Code de mesa. */
  tableName: string | null;
  restaurantName: string;
  feeBps: number;
  acceptingOrders: boolean;
  /** O cliente pode enviar o pedido pelo sistema. */
  canOrder: boolean;
  /** Menu de demonstração: o carrinho funciona, mas nada é enviado. */
  demo: boolean;
  /** Número do restaurante (só dígitos) quando o pedido por WhatsApp está disponível. */
  whatsapp: string | null;
  lines: CartLine[];
  notices: string[];
  onQuantity: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  onEdit: (line: CartLine) => void;
  /** O servidor recusou algo que depende do menu atual (ex.: prato esgotado): pede ao ecrã que o volte a ler. */
  onMenuStale: () => void;
  onPlaced: (order: PublicOrderView) => void;
}

interface Problem {
  title: string;
  text: string;
  retryable?: boolean;
}

function describe(err: unknown): Problem {
  if (err instanceof ApiError) {
    if (err.isNetwork)
      return { title: 'O pedido ainda não foi confirmado', text: 'Sem resposta do servidor. Se o pedido já tiver chegado, tocar em "Enviar pedido" outra vez não o duplica.', retryable: true };
    switch (err.code) {
      case 'ITEM_UNAVAILABLE':
      case 'ITEM_NOT_FOUND':
      case 'OPTION_NOT_FOUND':
        return { title: 'O menu mudou', text: `${err.message} Verifique o pedido e envie de novo.` };
      case 'NOT_ACCEPTING_ORDERS':
        return { title: 'Pedidos por QR Code pausados', text: err.message };
      case 'TOO_MANY_PENDING_ORDERS':
      case 'ORDERING_TOO_FAST':
      case 'RATE_LIMITED':
        return { title: 'Aguarde um momento', text: err.message, retryable: true };
      case 'ORDER_TOO_LARGE':
        return { title: 'Pedido demasiado grande', text: 'Divida o pedido em dois ou chame um empregado.' };
      default:
        return { title: 'Não foi possível enviar', text: err.message, retryable: err.status >= 500 };
    }
  }
  return { title: 'Não foi possível enviar', text: 'Ocorreu um erro inesperado. Tente novamente.', retryable: true };
}

/** O pedido do cliente, apresentado como uma comanda. */
export function CartSheet({ open, onClose, token, tableName, restaurantName, feeBps, acceptingOrders, canOrder, demo, whatsapp, lines, notices, onQuantity, onRemove, onEdit, onMenuStale, onPlaced }: Props) {
  const [orderNotes, setOrderNotes] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // a mesma chave é reutilizada enquanto o pedido não mudar: reenviar depois de uma falha de rede nunca duplica
  const attempt = useRef<{ key: string; signature: string } | null>(null);

  const subtotal = cartSubtotal(lines);
  const fee = feeFor(subtotal, feeBps);
  const units = cartUnits(lines);
  const tooMany = units > MAX_UNITS;

  useLayoutEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const sendWhatsapp = () => {
    if (!whatsapp || lines.length === 0) return;
    const text = whatsappText({ restaurant: restaurantName, table: tableName, lines, notes: orderNotes, fee: fee > 0 ? { label: `Taxa de serviço (${feeLabel(feeBps)})`, cents: fee } : null, total: subtotal + fee });
    window.open(whatsappUrl(whatsapp, text), '_blank', 'noopener,noreferrer');
  };

  const send = async () => {
    if (sending || lines.length === 0 || tooMany) return;
    const payload = toPayload(lines, orderNotes);
    const signature = JSON.stringify(payload);
    if (!attempt.current || attempt.current.signature !== signature) attempt.current = { key: randomKey(18), signature };
    setSending(true);
    setProblem(null);
    try {
      const res = await publicApi.placeOrder(token, payload, attempt.current.key);
      attempt.current = null;
      setOrderNotes('');
      onPlaced(res.order);
    } catch (err) {
      const p = describe(err);
      setProblem(p);
      if (err instanceof ApiError && ['ITEM_UNAVAILABLE', 'ITEM_NOT_FOUND', 'OPTION_NOT_FOUND', 'NOT_ACCEPTING_ORDERS'].includes(err.code)) onMenuStale();
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={sending}
      title={`O seu pedido`}
      footer={
        <div className="stack-sm">
          {problem ? (
            <div className="notice notice-danger" role="alert">
              <strong>{problem.title}.</strong> {problem.text}
            </div>
          ) : null}
          {demo ? (
            <p className="notice" role="status">
              <strong>Menu de demonstração.</strong> Pode montar o pedido e ver o total, mas nada é enviado.
            </p>
          ) : null}
          {canOrder && !demo ? (
            <Button size="big" block split loading={sending} disabled={lines.length === 0 || !acceptingOrders || tooMany} onClick={send}>
              <span>{sending ? 'A enviar…' : 'Enviar pedido'}</span>
              {sending ? null : <Money cents={subtotal + fee} />}
            </Button>
          ) : null}
          {whatsapp && !demo ? (
            <Button size="big" block split variant={canOrder ? 'secondary' : 'primary'} disabled={lines.length === 0 || tooMany} onClick={sendWhatsapp}>
              <span>Enviar por WhatsApp</span>
              <Money cents={subtotal + fee} />
            </Button>
          ) : null}
          {demo ? (
            <Button size="big" block split disabled>
              <span>Enviar pedido</span>
              <Money cents={subtotal + fee} />
            </Button>
          ) : null}
          <p className="hint center">{canOrder && !demo ? 'O pagamento é feito diretamente no restaurante.' : 'O restaurante confirma o pedido e o pagamento é feito diretamente com ele.'}</p>
        </div>
      }
    >
      <div className="stack">
        {notices.map((n) => (
          <p key={n} className="notice" role="status">
            {n}
          </p>
        ))}
        {canOrder && !acceptingOrders ? <p className="notice notice-danger">O restaurante não está a receber pedidos por QR Code neste momento. Peça a um empregado.</p> : null}
        {tooMany ? <p className="notice notice-danger">Um pedido pode ter no máximo {MAX_UNITS} unidades. Retire algumas ou faça dois pedidos.</p> : null}

        {lines.length === 0 ? (
          <div className="state">
            <h2>O pedido está vazio</h2>
            <p>Toque em + nos pratos que quiser pedir.</p>
          </div>
        ) : (
          <div className="ticket ticket-torn comanda">
            <p className="comanda-where voice">{tableName ?? restaurantName}</p>
            <ul className="comanda-lines">
              {lines.map((l) => (
                <li key={l.key} className="comanda-line">
                  <div className="leader comanda-main">
                    <span className="lead">
                      <b className="num">{l.quantity}×</b> {l.name}
                    </span>
                    <span className="fill" aria-hidden="true" />
                    <span className="tail">
                      <Money cents={lineTotal(l)} />
                    </span>
                  </div>
                  {l.options.length > 0 ? (
                    <p className="comanda-sub muted">+ {l.options.map((o) => o.name).join(', ')}</p>
                  ) : null}
                  {l.notes ? (
                    <p className="comanda-sub">
                      <span className="marker">{l.notes}</span>
                    </p>
                  ) : null}
                  <div className="comanda-actions">
                    <Stepper small label={`Quantidade de ${l.name}`} value={l.quantity} min={0} max={MAX_LINE_QUANTITY} onChange={(q) => onQuantity(l.key, q)} />
                    <Button variant="quiet" size="sm" onClick={() => onEdit(l)} aria-label={`Alterar ${l.name}`}>
                      Alterar
                    </Button>
                    <Button variant="danger-quiet" size="sm" onClick={() => onRemove(l.key)} aria-label={`Remover ${l.name}`}>
                      Remover
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <hr className="cut-line" />
            <div className="comanda-totals">
              <div className="leader">
                <span className="lead muted">{plural(units, 'unidade', 'unidades')}</span>
                <span className="fill" aria-hidden="true" />
                <span className="tail">
                  <Money cents={subtotal} />
                </span>
              </div>
              {fee > 0 ? (
                <div className="leader">
                  <span className="lead muted">Taxa de serviço ({feeLabel(feeBps)})</span>
                  <span className="fill" aria-hidden="true" />
                  <span className="tail">
                    <Money cents={fee} />
                  </span>
                </div>
              ) : null}
              <div className="leader comanda-total">
                <span className="lead voice">Total</span>
                <span className="fill" aria-hidden="true" />
                <span className="tail voice">{kz(subtotal + fee)}</span>
              </div>
            </div>
          </div>
        )}

        {lines.length > 0 ? (
          <TextArea label="Alguma indicação para o pedido? (opcional)" placeholder="Ex.: trazer tudo ao mesmo tempo" maxLength={500} rows={2} value={orderNotes} onChange={(e) => setOrderNotes(e.target.value)} />
        ) : null}
      </div>
    </Sheet>
  );
}
