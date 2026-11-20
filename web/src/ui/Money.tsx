import { kz } from '../lib/format';

export function Money({ cents, className = '' }: { cents: number; className?: string }) {
  return <span className={`num nowrap ${className}`}>{kz(cents)}</span>;
}
