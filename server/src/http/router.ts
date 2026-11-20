import type { RouteSpec } from './types';

interface Compiled {
  spec: RouteSpec;
  regex: RegExp;
  keys: string[];
}

export type Match =
  | { kind: 'ok'; route: RouteSpec; params: Record<string, string> }
  | { kind: 'method'; allow: string[] }
  | { kind: 'none' };

/** Router simples: caminhos como /api/orders/:id. Cada segmento ":nome" aceita qualquer texto sem "/". */
export class Router {
  private readonly routes: Compiled[] = [];

  add(spec: RouteSpec): void {
    const keys: string[] = [];
    const pattern = spec.path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ spec, regex: new RegExp(`^${pattern}/?$`), keys });
  }

  addAll(specs: RouteSpec[]): void {
    for (const s of specs) this.add(s);
  }

  match(method: string, pathname: string): Match {
    const effective = method === 'HEAD' ? 'GET' : method;
    const allow = new Set<string>();
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      if (r.spec.method === effective) {
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]!);
          } catch {
            params[k] = m[i + 1]!;
          }
        });
        return { kind: 'ok', route: r.spec, params };
      }
      allow.add(r.spec.method);
    }
    return allow.size ? { kind: 'method', allow: [...allow] } : { kind: 'none' };
  }

  list(): RouteSpec[] {
    return this.routes.map((r) => r.spec);
  }
}
