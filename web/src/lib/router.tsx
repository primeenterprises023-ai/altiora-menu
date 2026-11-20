// Navegação mínima: endereços reais (sem #), botão "voltar" do navegador e ligações normais que não recarregam a página.
import { useCallback, useEffect, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const snapshot = () => window.location.pathname + window.location.search;

export interface Location {
  pathname: string;
  search: string;
  params: URLSearchParams;
}

export function useLocation(): Location {
  const full = useSyncExternalStore(subscribe, snapshot, () => '/');
  return useMemo(() => {
    const q = full.indexOf('?');
    const pathname = q === -1 ? full : full.slice(0, q);
    const search = q === -1 ? '' : full.slice(q);
    return { pathname, search, params: new URLSearchParams(search) };
  }, [full]);
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === snapshot()) return;
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  if (!opts.replace) window.scrollTo(0, 0);
  notify();
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
  children?: ReactNode;
}

export function Link({ to, replace, onClick, children, ...rest }: LinkProps) {
  const handle = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === '_blank') return;
      e.preventDefault();
      navigate(to, { replace });
    },
    [to, replace, onClick, rest.target],
  );
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

export type Params = Record<string, string>;

/** "/menu/:token/pedidos" combina com "/menu/abc/pedidos" → { token: "abc" }. Termina em "/*" para aceitar o resto. */
export function matchPath(pattern: string, pathname: string): Params | null {
  const clean = (s: string) => s.replace(/\/+$/, '');
  const wildcard = pattern.endsWith('/*');
  const pat = clean(wildcard ? pattern.slice(0, -2) : pattern).split('/');
  const path = clean(pathname).split('/');
  if (wildcard ? path.length < pat.length : path.length !== pat.length) return null;
  const params: Params = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    const v = path[i]!;
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(v);
      } catch {
        return null;
      }
    } else if (p !== v) return null;
  }
  if (wildcard) params['*'] = path.slice(pat.length).join('/');
  return params;
}

export interface RouteDef {
  path: string;
  render: (params: Params) => ReactNode;
}

export function Routes({ routes, fallback }: { routes: RouteDef[]; fallback: ReactNode }) {
  const { pathname } = useLocation();
  for (const r of routes) {
    const params = matchPath(r.path, pathname);
    if (params) return <>{r.render(params)}</>;
  }
  return <>{fallback}</>;
}

/** Redireciona (sem deixar a página atual no histórico). */
export function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return null;
}
