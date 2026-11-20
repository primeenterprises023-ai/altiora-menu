import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'info' | 'danger';
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}
interface ToastApi {
  show: (text: string, tone?: Tone) => void;
  /** Retira todos os avisos (ex.: ao mudar de página). */
  clear: () => void;
}

const Ctx = createContext<ToastApi>({ show: () => undefined, clear: () => undefined });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const show = useCallback((text: string, tone: Tone = 'info') => {
    const id = nextId.current++;
    setItems((cur) => [...cur.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), tone === 'danger' ? 6000 : 2600);
  }, []);
  const clear = useCallback(() => setItems([]), []);
  const api = useMemo(() => ({ show, clear }), [show, clear]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.tone === 'danger' ? ' toast-danger' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
