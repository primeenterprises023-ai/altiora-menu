import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface Common {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

function Wrap({ id, label, hint, error, children }: Common & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-err`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const describe = (id: string, hint: ReactNode, error?: string | null) => [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;

export function TextField({ label, hint, error, className = '', ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <input id={id} className={`input ${className}`} aria-invalid={error ? true : undefined} aria-describedby={describe(id, hint, error)} {...rest} />
    </Wrap>
  );
}

export function TextArea({ label, hint, error, className = '', ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <textarea id={id} className={`textarea ${className}`} aria-invalid={error ? true : undefined} aria-describedby={describe(id, hint, error)} {...rest} />
    </Wrap>
  );
}

export function SelectField({ label, hint, error, className = '', children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <select id={id} className={`select ${className}`} aria-describedby={describe(id, hint, error)} {...rest}>
        {children}
      </select>
    </Wrap>
  );
}

/** Interruptor ligado/desligado. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/** Quantidade com − e +. */
export function Stepper({ value, onChange, min = 0, max = 99, label, small }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string; small?: boolean }) {
  return (
    <div className={`stepper${small ? ' stepper-sm' : ''}`} role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Diminuir ${label.toLowerCase()}`}>
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`Aumentar ${label.toLowerCase()}`}>
        +
      </button>
    </div>
  );
}
