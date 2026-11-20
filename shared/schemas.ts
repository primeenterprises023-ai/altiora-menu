// Validação dos dados enviados à API (Zod). Usada pelo servidor e pelos formulários da equipa.
// Nota: os pedidos dos clientes NUNCA incluem preços ou totais — o servidor calcula tudo.
import { z } from 'zod';
import { ALLERGEN_CODES } from './allergens';
import { WEEKDAYS, isTime } from './hours';
import { FEATURE_KEYS, CURRENCIES } from './plans';
import { PAYMENT_METHODS } from './payments';
import { ORDER_STATUSES } from './status';

export const uuid = z.string().uuid();

// O caráter nulo (\u0000) não é aceite pela base de dados: recusa-se logo à entrada, em todos os textos.
const noNul = (s: string) => !s.includes('\u0000');
const NUL_MESSAGE = 'O texto contém caracteres inválidos.';
const text = (max: number, min = 1) => z.string().trim().min(min).max(max).refine(noNul, NUL_MESSAGE);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(noNul, NUL_MESSAGE)
    .nullish()
    .transform((v) => (v ? v : null));
const urlOrPath = z
  .string()
  .trim()
  .max(500)
  .regex(/^(https:\/\/[^\s\u0000]+|\/[^\s/\u0000][^\s\u0000]*)$/, 'Use um endereço que comece por https://');
const optionalUrl = z
  .union([urlOrPath, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

/** Endereço de um ficheiro do próprio sistema (fotografia ou modelo 3D enviado pelo gerente): "/a/<id>". */
const assetPath = z
  .union([z.string().trim().regex(/^\/a\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Ficheiro inválido.'), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
const ingredients = z
  .array(text(60))
  .max(30, 'No máximo 30 ingredientes.')
  .transform((list) => Array.from(new Set(list.map((s) => s.trim()))));
const allergens = z
  .array(z.string())
  .max(14)
  .refine((list) => list.every((c) => ALLERGEN_CODES.includes(c)), 'Alergénio desconhecido.')
  .transform((list) => Array.from(new Set(list)));
const phoneDigits = z
  .union([z.string().trim().max(40), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    const digits = v.replace(/[\s().+-]/g, '');
    if (!/^[0-9]{8,15}$/.test(digits)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Escreva o número com o indicativo do país, por exemplo +244 923 000 000.' });
      return z.NEVER;
    }
    return digits;
  });
const optionalEmail = z
  .union([z.string().trim().toLowerCase().email().max(160), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
const httpsUrl = z
  .union([z.string().trim().max(500).regex(/^https:\/\/[^\s\u0000]+$/, 'Use um endereço que comece por https://'), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
const timeRange = z.tuple([z.string().refine(isTime, 'Hora inválida.'), z.string().refine(isTime, 'Hora inválida.')]).refine(([a, b]) => a !== b, 'A hora de abertura e a de fecho não podem ser iguais.');
const openingHours = z
  .object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(timeRange).max(3).optional()])) as Record<(typeof WEEKDAYS)[number], z.ZodOptional<z.ZodArray<typeof timeRange>>>)
  .strict();

const atLeastOne = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine((o: Record<string, unknown>) => Object.keys(o).length > 0, { message: 'Indique pelo menos um campo a alterar.' });

// --- autenticação ---------------------------------------------------------
export const LoginInput = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

export const ChangePasswordInput = z
  .object({
    current_password: z.string().min(1).max(200),
    new_password: z.string().min(1).max(200),
  })
  .strict();

export const SwitchRestaurantInput = z.object({ restaurant_id: uuid }).strict();

// --- pedidos --------------------------------------------------------------
export const OrderItemInput = z
  .object({
    menu_item_id: uuid,
    quantity: z.number().int().min(1).max(20),
    notes: optionalText(300),
    options: z
      .array(z.object({ option_id: uuid, quantity: z.number().int().min(1).max(10).default(1) }).strict())
      .max(15)
      .default([]),
  })
  .strict();

const orderLines = z
  .array(OrderItemInput)
  .min(1)
  .max(40)
  .refine((items) => items.reduce((n, i) => n + i.quantity, 0) <= 100, { message: 'Um pedido pode ter no máximo 100 unidades.' });

export const CreateOrderInput = z.object({ items: orderLines, notes: optionalText(500) }).strict();
export const StaffCreateOrderInput = z.object({ table_id: uuid, items: orderLines, notes: optionalText(500) }).strict();

export const OrderStatusInput = z
  .object({
    to: z.enum(ORDER_STATUSES),
    /** Estado que a pessoa estava a ver; evita conflitos entre dois tablets. */
    from: z.enum(ORDER_STATUSES).optional(),
    reason: z.string().trim().min(3).max(300).refine(noNul, NUL_MESSAGE).optional(),
  })
  .strict();

// --- mesas ----------------------------------------------------------------
export const TableCreateInput = z
  .object({ table_number: z.number().int().min(1).max(9999), label: optionalText(60) })
  .strict();
export const TableUpdateInput = atLeastOne(
  z.object({ label: optionalText(60), active: z.boolean() }).partial().strict(),
);

// --- menu -----------------------------------------------------------------
const price = z.number().int().min(0).max(100_000_000_000);

export const CategoryInput = z.object({ name: text(80), display_order: z.number().int().min(0).max(100000).default(0), active: z.boolean().default(true) }).strict();
export const CategoryUpdateInput = atLeastOne(
  z.object({ name: text(80), display_order: z.number().int().min(0).max(100000), active: z.boolean() }).partial().strict(),
);

export const MenuItemInput = z
  .object({
    category_id: uuid,
    name: text(120),
    description: optionalText(600),
    image_url: optionalUrl,
    thumb_url: optionalUrl,
    model_url: assetPath,
    ingredients: ingredients.default([]),
    allergens: allergens.default([]),
    price_cents: price,
    available: z.boolean().default(true),
    active: z.boolean().default(true),
    display_order: z.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const MenuItemUpdateInput = atLeastOne(
  z
    .object({
      category_id: uuid,
      name: text(120),
      description: optionalText(600),
      image_url: optionalUrl,
      thumb_url: optionalUrl,
      model_url: assetPath,
      ingredients,
      allergens,
      price_cents: price,
      available: z.boolean(),
      active: z.boolean(),
      display_order: z.number().int().min(0).max(100000),
    })
    .partial()
    .strict(),
);
export const AvailabilityInput = z.object({ available: z.boolean() }).strict();

export const OptionInput = z
  .object({
    name: text(80),
    price_delta_cents: price.default(0),
    kind: z.enum(['extra', 'size']).default('extra'),
    active: z.boolean().default(true),
    display_order: z.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const OptionUpdateInput = atLeastOne(
  z.object({ name: text(80), price_delta_cents: price, kind: z.enum(['extra', 'size']), active: z.boolean(), display_order: z.number().int().min(0).max(100000) }).partial().strict(),
);

// --- restaurante ----------------------------------------------------------
export const RestaurantUpdateInput = atLeastOne(
  z
    .object({
      name: text(120, 2),
      description: optionalText(500),
      logo_url: optionalUrl,
      cover_url: optionalUrl,
      accent_color: z
        .union([z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB.'), z.literal(''), z.null()])
        .transform((v) => (v ? v : null)),
      address: optionalText(200),
      phone: optionalText(40),
      email: optionalEmail,
      whatsapp: phoneDigits,
      maps_url: httpsUrl,
      opening_hours: openingHours,
      theme: z.enum(['dark', 'light']),
      font: z.enum(['serif', 'sans']),
      timezone: text(60),
      service_fee_bps: z.number().int().min(0).max(3000),
      accepting_orders: z.boolean(),
    })
    .partial()
    .strict(),
);

// --- pagamentos (registados pela equipa) -------------------------------------------
export const PaymentCreateInput = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    status: z.enum(['pago', 'isento']).default('pago'),
    /** Se não for indicado, assume-se o que falta pagar do pedido. */
    amount_cents: z.number().int().min(1).max(100_000_000_000).optional(),
    /** Ex.: número da transferência. Na isenção é obrigatório e explica o motivo. */
    reference: optionalText(100),
  })
  .strict();

export const PaymentUpdateInput = z
  .object({ status: z.enum(['reembolsado', 'anulado']), reason: text(300, 3) })
  .strict();

// --- equipa do restaurante ----------------------------------------------------------
export const StaffCreateInput = z
  .object({
    name: text(120),
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(['manager', 'waiter', 'kitchen']),
  })
  .strict();

export const StaffUpdateInput = atLeastOne(z.object({ role: z.enum(['manager', 'waiter', 'kitchen']), active: z.boolean() }).partial().strict());

// --- relatórios -----------------------------------------------------------------------
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use uma data no formato AAAA-MM-DD.');
export const ReportQuery = z.object({ from: isoDay.optional(), to: isoDay.optional() }).strict();

// --- registo de atividade (gerente) ----------------------------------------------------
export const ActivityQuery = z
  .object({
    /** "Ver mais antigos": o id da última linha recebida. */
    before: z.string().regex(/^\d{1,18}$/, 'Posição inválida.').optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

// --- plataforma (Altiora Grupo) ----------------------------------------------
export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use apenas letras minúsculas, números e hífenes (ex.: terraza-talatona).');

export const AdminCreateRestaurantInput = z
  .object({
    name: text(120, 2),
    slug: slug.optional(),
    plan_code: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/).optional(),
    currency: z.enum(CURRENCIES).optional(),
    manager: z.object({ name: text(120), email: z.string().trim().toLowerCase().email().max(254) }).strict(),
  })
  .strict();

export const AdminUpdateRestaurantInput = atLeastOne(
  z.object({ status: z.enum(['ativo', 'suspenso', 'desativado']), name: text(120, 2) }).partial().strict(),
);

// --- planos, assinaturas e contactos (plataforma) --------------------------------------------------
const featureList = z.array(z.enum(FEATURE_KEYS)).max(FEATURE_KEYS.length).transform((l) => Array.from(new Set(l)));
const planPrice = z
  .object({
    currency: z.enum(CURRENCIES),
    monthly_cents: z.number().int().min(0).max(100_000_000_000),
    yearly_cents: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null),
  })
  .strict();
const planFields = {
  name: text(40, 2),
  tagline: z.string().trim().max(160).refine(noNul, NUL_MESSAGE).default(''),
  display_order: z.number().int().min(0).max(1000),
  highlighted: z.boolean(),
  active: z.boolean(),
  features: featureList,
  prices: z
    .array(planPrice)
    .max(CURRENCIES.length)
    .refine((l) => new Set(l.map((p) => p.currency)).size === l.length, 'Cada moeda só pode ter um preço.'),
};
export const PlanCreateInput = z.object({ code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Use letras minúsculas, números e _ (ex.: gold).'), ...planFields }).strict();
export const PlanUpdateInput = atLeastOne(z.object(planFields).partial().strict());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use uma data no formato AAAA-MM-DD.');
export const SubscriptionUpdateInput = atLeastOne(
  z
    .object({
      plan_code: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
      status: z.enum(['ativa', 'em_atraso', 'cancelada']),
      valid_until: z.union([isoDate, z.null()]),
      notes: optionalText(500),
    })
    .partial()
    .strict(),
);
export const LeadUpdateInput = z.object({ status: z.enum(['novo', 'contactado', 'arquivado']) }).strict();

export type CreateOrder = z.infer<typeof CreateOrderInput>;
export type StaffCreateOrder = z.infer<typeof StaffCreateOrderInput>;
