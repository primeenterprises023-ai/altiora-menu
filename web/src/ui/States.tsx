import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { Button } from './Button';

export function Loading({ rows = 4, label = 'A carregar…' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} className={i % 3 === 0 ? 'tall' : ''} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: ApiError | Error | null; onRetry?: () => void; title?: string }) {
  const network = error instanceof ApiError && error.isNetwork;
  return (
    <div className="state" role="alert">
      <h2>{title ?? (network ? 'Sem ligação' : 'Não foi possível carregar')}</h2>
      <p>{error?.message ?? 'Ocorreu um erro inesperado.'}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Tentar novamente
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** Aviso discreto quando a atualização automática falha mas já há dados no ecrã. */
export function StaleNotice({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="notice notice-danger" role="status">
      <strong>{error.isNetwork ? 'Sem ligação.' : 'Atualização falhou.'}</strong> Os dados mostrados podem estar desatualizados; a tentar de novo automaticamente.
    </div>
  );
}
