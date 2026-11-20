// Registo de atividade da equipa: transforma os registos de auditoria (códigos e dados técnicos) em frases que o gerente entende.
// Nunca mostra endereços IP, e-mails, palavras-passe, tokens nem códigos: só o que ajuda a perceber quem fez o quê.
import { formatMoney } from './money';
import { STATUS_LABEL, isOrderStatus } from './status';
import { METHOD_LABEL } from './payments';

type Meta = Record<string, unknown>;

const str = (v: unknown, max = 80): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Meta | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Meta) : null);
const quoted = (name: string | null): string => (name ? ` «${name}»` : '');
const statusLabel = (v: unknown): string | null => (isOrderStatus(v) ? STATUS_LABEL[v] : null);
/** Procura só nas chaves próprias do mapa (nunca em "constructor", "toString"…). */
const own = (map: Record<string, string>, key: unknown): string | null => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key]! : null);

const ROLES: Record<string, string> = { manager: 'gerente', waiter: 'empregado de mesa', kitchen: 'cozinha' };
const role = (v: unknown): string => own(ROLES, v) ?? 'equipa';

/** Em que perfil a pessoa estava quando fez a ação ("Gerente", "Cozinha"…). */
export function actorRoleLabel(r: string | null | undefined): string {
  switch (r) {
    case 'manager':
      return 'Gerente';
    case 'waiter':
      return 'Empregado de mesa';
    case 'kitchen':
      return 'Cozinha';
    default:
      return '';
  }
}

/** "a mesa 4" (se o número vier nos dados) ou "uma mesa". */
const theTable = (m: Meta): string => {
  const n = int(m.table_number);
  return n !== null ? `a mesa ${n}` : 'uma mesa';
};
/** "da mesa 4" ou "de uma mesa". */
const ofTable = (m: Meta): string => {
  const n = int(m.table_number);
  return n !== null ? `da mesa ${n}` : 'de uma mesa';
};
/** "para a mesa 4" ou "para uma mesa". */
const forTable = (m: Meta): string => `para ${theTable(m)}`;

/** A frase de uma ação, sem o nome da pessoa ("Criou o prato «Muamba»…"). Ações desconhecidas ficam com o código à vista. */
export function describeActivity(action: string, metadata: unknown, currency: string = 'AOA'): string {
  const m = obj(metadata) ?? {};
  const money = (cents: number | null) => (cents === null ? '' : formatMoney(cents, currency));

  switch (action) {
    // ---- menu ----
    case 'menu.category.create':
      return `Criou a categoria${quoted(str(m.name))}.`;
    case 'menu.category.update':
      return 'Alterou uma categoria do menu.';
    case 'menu.category.delete':
      return 'Apagou uma categoria do menu.';
    case 'menu.item.create': {
      const p = money(int(m.price_cents));
      return `Criou o prato${quoted(str(m.name))}${p ? ` (${p})` : ''}.`;
    }
    case 'menu.item.update': {
      const change = obj(m.price_change);
      const from = change ? int(change.from) : null;
      const to = change ? int(change.to) : null;
      return from !== null && to !== null && from !== to ? `Alterou um prato: o preço passou de ${money(from)} para ${money(to)}.` : 'Alterou um prato do menu.';
    }
    case 'menu.item.availability':
      return m.available === false ? 'Marcou um prato como esgotado.' : 'Voltou a marcar um prato como disponível.';
    case 'menu.item.delete':
      return 'Apagou um prato do menu.';
    case 'menu.option.create':
      return `Criou a opção${quoted(str(m.name))} num prato.`;
    case 'menu.option.update':
      return 'Alterou uma opção de um prato.';
    case 'menu.option.delete':
      return 'Apagou uma opção de um prato.';
    case 'asset.upload': {
      const kind = m.kind === 'model' ? 'um modelo 3D' : 'uma fotografia';
      return `Enviou ${kind}.`;
    }

    // ---- mesas e QR Codes ----
    case 'table.create':
      return `Criou ${theTable(m)}.`;
    case 'table.update':
      if (m.active_changed === true) return m.active === false ? `Desativou ${theTable(m)}.` : `Reativou ${theTable(m)}.`;
      return m.label_changed === true ? `Mudou o nome ${ofTable(m)}.` : `Alterou ${theTable(m)}.`;
    case 'table.qr_regenerated':
      return `Gerou um novo QR Code ${forTable(m)}. O anterior deixou de funcionar.`;
    case 'table.delete':
      return 'Apagou uma mesa.';
    case 'table.session_closed':
      return `Libertou ${theTable(m)}.`;
    case 'qr.download': {
      if (m.kind === 'tables') {
        const n = int(m.count);
        return n !== null ? `Descarregou o PDF dos QR Codes de ${n} ${n === 1 ? 'mesa' : 'mesas'}.` : 'Descarregou o PDF dos QR Codes das mesas.';
      }
      return 'Descarregou o PDF do QR Code do restaurante.';
    }
    case 'waiter_call.attend':
      return `Atendeu o chamamento ${ofTable(m)}.`;

    // ---- pedidos e pagamentos registados pela equipa ----
    case 'order.cancel': {
      const why = str(m.reason, 120);
      return `Cancelou um pedido${why ? ` (motivo: ${why})` : ''}.`;
    }
    case 'order.correct': {
      const why = str(m.reason, 120);
      const from = statusLabel(m.from);
      const to = statusLabel(m.to);
      const change = from && to ? `: de «${from}» para «${to}»` : '';
      return `Corrigiu o estado de um pedido${change}${why ? ` (motivo: ${why})` : ''}.`;
    }
    case 'payment.record': {
      const method = own(METHOD_LABEL, m.method) ?? '';
      const amount = money(int(m.amount_cents));
      return `Registou um pagamento${amount ? ` de ${amount}` : ''}${method ? ` (${String(method).toLowerCase()})` : ''}.`;
    }
    case 'payment.exempt': {
      const why = str(m.reason, 120);
      return `Registou um pedido como isento de pagamento${why ? ` (motivo: ${why})` : ''}.`;
    }
    case 'payment.refund': {
      const amount = money(int(m.amount_cents));
      return `Registou um reembolso${amount ? ` de ${amount}` : ''}.`;
    }
    case 'payment.void': {
      const amount = money(int(m.amount_cents));
      return `Anulou um registo de pagamento${amount ? ` de ${amount}` : ''}.`;
    }

    // ---- acessos (sem IP nem aparelho) ----
    case 'auth.login':
      return 'Iniciou sessão.';
    case 'auth.password_changed':
      return 'Mudou a própria palavra-passe.';

    // ---- equipa e definições ----
    case 'staff.create':
      return `Criou uma conta de ${role(m.role)}.`;
    case 'staff.update': {
      const r = obj(m.role);
      const a = obj(m.active);
      const parts: string[] = [];
      if (r) parts.push(`função de ${role(r.from)} para ${role(r.to)}`);
      if (a) parts.push(a.to === false ? 'conta desativada' : 'conta reativada');
      return parts.length ? `Alterou uma conta da equipa: ${parts.join('; ')}.` : 'Alterou uma conta da equipa.';
    }
    case 'staff.password_reset':
      return 'Repôs a palavra-passe de uma conta da equipa.';
    case 'restaurant.update': {
      if (typeof m.accepting_orders === 'boolean') return m.accepting_orders ? 'Retomou os pedidos por QR Code.' : 'Pausou os pedidos por QR Code.';
      const bps = int(m.service_fee_bps);
      if (bps !== null) return `Alterou a taxa de serviço para ${(bps / 100).toString().replace('.', ',')} %.`;
      return 'Alterou as definições do restaurante.';
    }
    case 'report.export': {
      const from = str(m.from, 10);
      const to = str(m.to, 10);
      return from && to ? `Exportou o relatório de vendas em CSV (${dmy(from)} a ${dmy(to)}).` : 'Exportou o relatório de vendas em CSV.';
    }
    default:
      return `Ação registada (${action.slice(0, 60)}).`;
  }
}

/** "2026-11-14" → "14/11/2026" (sem fusos horários). */
function dmy(iso: string): string {
  const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return x ? `${x[3]}/${x[2]}/${x[1]}` : iso;
}
