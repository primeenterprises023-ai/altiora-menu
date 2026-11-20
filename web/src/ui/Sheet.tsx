import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Impede fechar por engano (ex.: enquanto se envia um pedido). */
  locked?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let openSheets = 0;
/** Pilha de folhas abertas: só a de cima responde ao teclado (Esc e Tab), mesmo havendo uma folha aberta por cima de outra. */
const stack: object[] = [];

/**
 * Diálogo que sobe do fundo (no telemóvel) ou aparece ao centro (no computador).
 * Prende o foco lá dentro, fecha com Esc ou ao tocar fora, e devolve o foco a quem o abriu.
 */
export function Sheet({ open, onClose, title, children, footer, wide, locked }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const me = {};
    stack.push(me);
    openSheets++;
    document.body.classList.add('locked');
    const root = document.getElementById('root');
    root?.setAttribute('aria-hidden', 'true');
    ref.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || stack[stack.length - 1] !== me) return;
      if (e.key === 'Escape' && !lockedRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = stack.indexOf(me);
      if (at >= 0) stack.splice(at, 1);
      openSheets--;
      if (openSheets <= 0) {
        openSheets = 0;
        document.body.classList.remove('locked');
        root?.removeAttribute('aria-hidden');
      }
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div ref={ref} className={`sheet${wide ? ' sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="sheet-close" onClick={onClose} disabled={locked} aria-label="Fechar">
            ×
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
