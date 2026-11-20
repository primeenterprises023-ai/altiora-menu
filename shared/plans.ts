// Planos comerciais do ALTIORA MENU e catálogo de funcionalidades.
// É usado pelo servidor (para recusar o que o plano não inclui), pelos painéis (para mostrar o que está bloqueado)
// e pela página comercial (tabela de planos). Os preços NÃO estão aqui: são definidos pela Altiora no painel.

export const FEATURE_KEYS = [
  'menu',
  'qr_codes',
  'basic_products',
  'orders',
  'whatsapp_orders',
  'tables',
  'stats',
  'advanced_branding',
  'exclusive_branding',
  'model_3d',
  'ar',
  'advanced_management',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureInfo {
  key: FeatureKey;
  label: string;
  description: string;
}

export const FEATURES: Record<FeatureKey, FeatureInfo> = {
  menu: { key: 'menu', label: 'Cardápio digital interativo', description: 'Menu com categorias, fotografias, pesquisa instantânea e filtros.' },
  qr_codes: { key: 'qr_codes', label: 'QR Code do restaurante em PDF', description: 'QR Code personalizado, pronto para imprimir em PDF.' },
  basic_products: { key: 'basic_products', label: 'Gestão de produtos', description: 'Criar, editar, ativar e desativar pratos, categorias e preços.' },
  orders: { key: 'orders', label: 'Pedidos digitais', description: 'O cliente pede pelo telemóvel e a cozinha e os empregados recebem em tempo real.' },
  whatsapp_orders: { key: 'whatsapp_orders', label: 'Pedidos por WhatsApp', description: 'O cliente envia o pedido já escrito para o WhatsApp do restaurante.' },
  tables: { key: 'tables', label: 'Gestão de mesas', description: 'Um QR Code por mesa, que identifica a mesa em cada pedido.' },
  stats: { key: 'stats', label: 'Estatísticas', description: 'Vendas, produtos mais vendidos e relatórios por período.' },
  advanced_branding: { key: 'advanced_branding', label: 'Personalização avançada', description: 'Cor e tema (claro ou escuro) do restaurante.' },
  exclusive_branding: { key: 'exclusive_branding', label: 'Personalização exclusiva', description: 'Menu sem a marca Altiora e escolha do estilo de letra do restaurante.' },
  model_3d: { key: 'model_3d', label: 'Pratos em 3D', description: 'Modelos 3D que o cliente roda e amplia com o dedo.' },
  ar: { key: 'ar', label: 'Realidade aumentada', description: 'O cliente vê o prato na sua mesa através do telemóvel (aparelhos compatíveis).' },
  advanced_management: { key: 'advanced_management', label: 'Gestão avançada', description: 'Exportação de relatórios em CSV e registo de atividade da equipa.' },
};

export const isFeatureKey = (v: unknown): v is FeatureKey => typeof v === 'string' && (FEATURE_KEYS as readonly string[]).includes(v);

export interface PlanDefaults {
  code: string;
  name: string;
  tagline: string;
  display_order: number;
  highlighted: boolean;
  features: FeatureKey[];
}

const STARTER: FeatureKey[] = ['menu', 'qr_codes', 'basic_products'];
const PRO: FeatureKey[] = [...STARTER, 'orders', 'whatsapp_orders', 'tables', 'stats', 'advanced_branding'];
const PREMIUM: FeatureKey[] = [...PRO, 'exclusive_branding', 'model_3d', 'ar', 'advanced_management'];

/** Planos criados pela migração. A Altiora pode editar nomes, preços e funcionalidades no painel. */
export const DEFAULT_PLANS: PlanDefaults[] = [
  { code: 'starter', name: 'Starter', tagline: 'O cardápio digital do seu restaurante, com QR Code.', display_order: 1, highlighted: false, features: STARTER },
  { code: 'pro', name: 'Pro', tagline: 'Pedidos digitais, mesas e estatísticas.', display_order: 2, highlighted: true, features: PRO },
  { code: 'premium', name: 'Premium', tagline: 'Pratos em 3D, realidade aumentada e personalização exclusiva.', display_order: 3, highlighted: false, features: PREMIUM },
];

/** Moedas aceites (todas com 2 casas decimais, como o Kwanza). */
export const CURRENCIES = ['AOA', 'USD', 'EUR', 'BRL', 'MZN', 'CVE', 'ZAR', 'GBP'] as const;
export type Currency = (typeof CURRENCIES)[number];
