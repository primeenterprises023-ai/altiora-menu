/** "Terraço do Mar & Sol" -> "terraco-do-mar-sol" (sem acentos, só letras minúsculas, números e hífenes). */
export function slugify(text: string): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s.length >= 2 ? s : 'restaurante';
}
