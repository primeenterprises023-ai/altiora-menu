import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-quiet';
  size?: 'sm' | 'md' | 'big';
  loading?: boolean;
  block?: boolean;
  split?: boolean;
  children?: ReactNode;
}

/** Botão. Em "loading" fica desativado e mostra que está a trabalhar (evita cliques duplos). */
export function Button({ variant = 'primary', size = 'md', loading = false, block = false, split = false, className = '', disabled, type = 'button', children, ...rest }: ButtonProps) {
  const cls = [
    'btn',
    variant === 'primary' ? '' : `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : size === 'big' ? 'btn-big' : '',
    block ? 'btn-block' : '',
    split ? 'btn-split' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
