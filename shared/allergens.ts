// Alergénios de declaração obrigatória (os 14 da lista da União Europeia, usada como referência internacional).
export const ALLERGENS = [
  { code: 'gluten', label: 'Glúten' },
  { code: 'crustaceos', label: 'Crustáceos' },
  { code: 'ovos', label: 'Ovos' },
  { code: 'peixe', label: 'Peixe' },
  { code: 'amendoim', label: 'Amendoim' },
  { code: 'soja', label: 'Soja' },
  { code: 'leite', label: 'Leite' },
  { code: 'frutos_casca_rija', label: 'Frutos de casca rija' },
  { code: 'aipo', label: 'Aipo' },
  { code: 'mostarda', label: 'Mostarda' },
  { code: 'sesamo', label: 'Sésamo' },
  { code: 'sulfitos', label: 'Sulfitos' },
  { code: 'tremoco', label: 'Tremoço' },
  { code: 'moluscos', label: 'Moluscos' },
] as const;

export type AllergenCode = (typeof ALLERGENS)[number]['code'];
export const ALLERGEN_CODES: readonly string[] = ALLERGENS.map((a) => a.code);
export const allergenLabel = (code: string): string => ALLERGENS.find((a) => a.code === code)?.label ?? code;
