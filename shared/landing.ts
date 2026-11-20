// Contrato da página comercial do ALTIORA MENU: os dados que o servidor entrega e o formulário de contacto.
import { z } from 'zod';
import type { FeatureKey } from './plans';

/** Uma funcionalidade do catálogo e se o plano a inclui. */
export interface LandingFeatureRow {
  key: FeatureKey;
  label: string;
  description: string;
  included: boolean;
}

export interface LandingPlan {
  code: string;
  name: string;
  tagline: string;
  highlighted: boolean;
  /** Todas as funcionalidades do catálogo, pela ordem do catálogo. */
  features: LandingFeatureRow[];
  /** null = a Altiora ainda não definiu preço: mostrar "Preço sob consulta". Valores em cêntimos (ver formatMoney). */
  price: { currency: string; monthly_cents: number; yearly_cents: number | null } | null;
}

export interface LandingDish {
  name: string;
  description: string;
  price_cents: number;
  category: string;
  /** Endereços do mesmo domínio ("/a/<id>"), ou null se o prato não tem fotografia / modelo 3D. */
  image_url: string | null;
  thumb_url: string | null;
  model_url: string | null;
  /** Já em português, por exemplo "Glúten", "Leite". */
  allergens: string[];
}

/** O restaurante de demonstração (fictício). Se não existir na base de dados, `demo` vem null e as secções de demonstração não aparecem. */
export interface LandingDemo {
  slug: string;
  name: string;
  description: string;
  currency: string;
  logo_url: string | null;
  cover_url: string | null;
  /** Até 12 pratos, para mostrar no exemplo do cardápio. */
  dishes: LandingDish[];
  /** Um prato que tem modelo 3D, para a demonstração em 3D (null se nenhum tem). */
  model_dish: LandingDish | null;
}

/** Contactos comerciais da Altiora (variáveis COMMERCIAL_* do servidor). Cada campo pode faltar: nunca se inventa um contacto. */
export interface LandingContacts {
  email: string | null;
  phone: string | null;
  /** Só dígitos, com indicativo do país (para ligações wa.me). */
  whatsapp: string | null;
  address: string | null;
}

export interface LandingData {
  /** Endereço público do site, sem barra final. Ex.: "https://menu.exemplo.ao" */
  base_url: string;
  plans: LandingPlan[];
  demo: LandingDemo | null;
  contacts: LandingContacts;
  /** Ano atual (para o rodapé). */
  year: number;
}

/** Endereços (com código de controlo no nome) dos ficheiros gerados pela construção do projeto. */
export interface LandingAssets {
  css: string;
  js: string;
  /** Tipo de letra (Lora) para pré-carregar, ou null. */
  font: string | null;
}

const noNul = (s: string) => !s.includes('\u0000');
const clean = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(noNul, 'O texto contém caracteres inválidos.')
    .optional()
    .default('');

/** Mensagem do formulário de contacto da página comercial (POST /api/leads). O campo "website" é uma armadilha para robôs: tem de vir vazio. */
export const LeadInput = z
  .object({
    name: z.string().trim().min(2, 'Indique o seu nome.').max(120).refine(noNul, 'O texto contém caracteres inválidos.'),
    business: clean(160),
    phone: clean(40),
    email: clean(160),
    message: clean(1500),
    consent: z.literal(true, { errorMap: () => ({ message: 'Para enviar, aceite que a Altiora Grupo o contacte.' }) }),
    website: clean(200),
  })
  .strict()
  .refine((v) => v.phone !== '' || v.email !== '', { message: 'Indique um telefone ou um e-mail para lhe respondermos.', path: ['phone'] })
  .refine((v) => v.email === '' || z.string().email().safeParse(v.email).success, { message: 'O e-mail não parece válido.', path: ['email'] });

export type LeadInputType = z.infer<typeof LeadInput>;
