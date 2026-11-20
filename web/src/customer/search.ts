// Pesquisa instantânea e filtros do menu do cliente: ignora maiúsculas e acentos ("acai" encontra "Açaí").
import type { MenuCategory } from '../../../shared/types';

export const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface MenuFilter {
  query: string;
  /** null = todas as categorias. */
  category: string | null;
  /** Códigos de alergénios que a pessoa quer evitar: os pratos que os contêm não aparecem. */
  excluded: ReadonlySet<string>;
}

export function filterMenu(categories: MenuCategory[], f: MenuFilter): MenuCategory[] {
  const words = fold(f.query).split(/\s+/).filter(Boolean);
  const out: MenuCategory[] = [];
  for (const c of categories) {
    if (f.category && c.id !== f.category) continue;
    const items = c.items.filter((i) => {
      if (f.excluded.size > 0 && i.allergens.some((a) => f.excluded.has(a))) return false;
      if (words.length === 0) return true;
      const haystack = fold(`${i.name} ${i.description ?? ''} ${i.ingredients.join(' ')} ${c.name}`);
      return words.every((w) => haystack.includes(w));
    });
    if (items.length > 0) out.push({ ...c, items });
  }
  return out;
}

export const countItems = (categories: MenuCategory[]): number => categories.reduce((n, c) => n + c.items.length, 0);
