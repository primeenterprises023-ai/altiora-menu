import { describe, expect, test } from 'bun:test';
import type { MenuCategory, MenuItem } from '../../../shared/types';
import { countItems, filterMenu, fold } from './search';

const item = (id: string, name: string, over: Partial<MenuItem> = {}): MenuItem => ({
  id, name, description: null, image_url: null, thumb_url: null, model_url: null, ingredients: [], allergens: [], price_cents: 100, available: true, options: [], ...over,
});
const menu: MenuCategory[] = [
  { id: 'c1', name: 'Entradas', items: [item('1', 'Salada de polvo', { ingredients: ['Polvo', 'Cebola'], allergens: ['moluscos'] }), item('2', 'Pastéis de bacalhau', { allergens: ['peixe', 'gluten', 'ovos'] })] },
  { id: 'c2', name: 'Sobremesas', items: [item('3', 'Açaí com banana', { description: 'Fruta e granola' }), item('4', 'Mousse de chocolate', { allergens: ['ovos', 'leite'] })] },
];
const f = (over: Partial<Parameters<typeof filterMenu>[1]> = {}) => ({ query: '', category: null, excluded: new Set<string>(), ...over });
const names = (c: MenuCategory[]) => c.flatMap((x) => x.items.map((i) => i.name));

describe('pesquisa do menu', () => {
  test('ignora acentos, maiúsculas e a ordem das palavras', () => {
    expect(fold('Açaí')).toBe('acai');
    expect(names(filterMenu(menu, f({ query: 'ACAI' })))).toEqual(['Açaí com banana']);
    expect(names(filterMenu(menu, f({ query: 'bacalhau pasteis' })))).toEqual(['Pastéis de bacalhau']);
  });
  test('procura também na descrição, nos ingredientes e no nome da categoria', () => {
    expect(names(filterMenu(menu, f({ query: 'granola' })))).toEqual(['Açaí com banana']);
    expect(names(filterMenu(menu, f({ query: 'cebola' })))).toEqual(['Salada de polvo']);
    expect(names(filterMenu(menu, f({ query: 'sobremesas' })))).toEqual(['Açaí com banana', 'Mousse de chocolate']);
  });
  test('filtra por categoria e junta com a pesquisa', () => {
    expect(names(filterMenu(menu, f({ category: 'c2' })))).toEqual(['Açaí com banana', 'Mousse de chocolate']);
    expect(filterMenu(menu, f({ category: 'c2', query: 'polvo' }))).toEqual([]);
  });
  test('esconde os pratos com os alergénios que a pessoa quer evitar', () => {
    expect(names(filterMenu(menu, f({ excluded: new Set(['ovos']) })))).toEqual(['Salada de polvo', 'Açaí com banana']);
    expect(countItems(filterMenu(menu, f({ excluded: new Set(['ovos', 'moluscos']) })))).toBe(1);
  });
  test('categorias que ficam vazias desaparecem; sem filtros devolve tudo', () => {
    expect(filterMenu(menu, f({ query: 'mousse' })).map((c) => c.id)).toEqual(['c2']);
    expect(countItems(filterMenu(menu, f()))).toBe(4);
  });
});
