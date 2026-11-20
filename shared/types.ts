// Tipos das respostas da API (partilhados entre servidor e aplicação web).
import type { OrderPaymentSummary, PaymentMethod, PaymentStatus } from './payments';
import type { OrderStatus, StaffRole } from './status';

import type { FeatureKey } from './plans';
import type { OpeningHours } from './hours';

export interface OrderItemOptionView {
  name: string;
  quantity: number;
  price_delta_cents: number;
}

export interface OrderItemView {
  id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  notes: string | null;
  options: OrderItemOptionView[];
}

/** Vista de um pedido para a equipa (cozinha, empregado, gerente). */
export interface OrderView {
  id: string;
  order_number: number;
  order_day: string;
  table_id: string;
  table_number: number;
  table_label: string | null;
  status: OrderStatus;
  source: 'qr' | 'staff';
  subtotal_cents: number;
  service_fee_cents: number;
  total_cents: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  preparing_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** Só para gerente e empregado (a cozinha não vê pagamentos). */
  payment: OrderPaymentSummary | null;
  items: OrderItemView[];
}

/** Vista pública de um pedido (página de acompanhamento do cliente). */
export interface PublicOrderView {
  order_number: number;
  public_code: string;
  status: OrderStatus;
  table_number: number;
  table_label: string | null;
  restaurant_name: string;
  /** Cor de destaque do restaurante (#RRGGBB), para a página do pedido ter a mesma identidade do menu. */
  accent_color: string | null;
  subtotal_cents: number;
  service_fee_cents: number;
  total_cents: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  preparing_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  items: OrderItemView[];
}

export interface PublicOrderSummary {
  order_number: number;
  public_code: string;
  status: OrderStatus;
  total_cents: number;
  created_at: string;
}

/** 'size' = o cliente escolhe exatamente um tamanho; 'extra' = adicionais opcionais. */
export type OptionKind = 'extra' | 'size';

export interface MenuOption {
  id: string;
  name: string;
  price_delta_cents: number;
  kind: OptionKind;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  thumb_url: string | null;
  /** Só vem preenchido se o plano do restaurante inclui 3D. */
  model_url: string | null;
  ingredients: string[];
  /** Códigos (ver shared/allergens.ts). */
  allergens: string[];
  price_cents: number;
  available: boolean;
  options: MenuOption[];
}

export interface MenuCategory {
  id: string;
  name: string;
  items: MenuItem[];
}

export interface PublicRestaurant {
  slug: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  cover_url: string | null;
  accent_color: string | null;
  service_fee_bps: number;
  address: string | null;
  phone: string | null;
  email: string | null;
  /** Só dígitos, com indicativo do país. */
  whatsapp: string | null;
  maps_url: string | null;
  opening_hours: OpeningHours;
  timezone: string;
  currency: string;
  theme: 'dark' | 'light';
  font: 'serif' | 'sans';
  is_demo: boolean;
  /** false = plano com personalização exclusiva: a marca Altiora some do menu. */
  show_brand: boolean;
}

export interface PublicMenuCapabilities {
  /** O cliente pode enviar o pedido pelo sistema (mesa identificada e plano com pedidos). */
  orders: boolean;
  /** O cliente pode enviar o pedido por WhatsApp (plano com WhatsApp e número configurado). */
  whatsapp: boolean;
  model_3d: boolean;
  ar: boolean;
  /** Botão «Chamar o garçom» (mesa identificada e plano com pedidos). */
  waiter_call: boolean;
}

export interface PublicMenu {
  restaurant: PublicRestaurant;
  /** null = página do restaurante aberta sem QR Code de mesa. */
  table: { number: number; label: string | null } | null;
  accepting_orders: boolean;
  capabilities: PublicMenuCapabilities;
  /** Chamada ao garçom ainda por atender nesta mesa. */
  waiter_call: WaiterCallPublic | null;
  categories: MenuCategory[];
}

export interface WaiterCallPublic {
  id: string;
  created_at: string;
}

export interface WaiterCallView {
  id: string;
  table_id: string;
  table_number: number;
  table_label: string | null;
  status: 'aberta' | 'atendida' | 'cancelada';
  created_at: string;
  resolved_at: string | null;
}

export interface PlaceOrderResponse {
  order: PublicOrderView;
  replayed: boolean;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: StaffRole | 'platform';
  must_change_password: boolean;
  restaurant: { id: string; name: string; slug: string; status: string } | null;
  memberships: Array<{ restaurant_id: string; restaurant_name: string; role: StaffRole }>;
  /** Funcionalidades do plano do restaurante (vazio para a plataforma). Serve para esconder o que o plano não inclui. */
  features: FeatureKey[];
}

export interface StaffTable {
  id: string;
  table_number: number;
  label: string | null;
  active: boolean;
  /** Pedidos ainda em curso (novo, em preparação, pronto). */
  active_orders: number;
  /** Pedidos prontos à espera de entrega. */
  ready_orders: number;
  /** Só devolvido ao gerente. */
  qr_url?: string;
  qr_rotated_at?: string;
}

// --- menu (vista da equipa: inclui pratos e extras desativados) -------------------------------
export interface StaffMenuOption {
  id: string;
  name: string;
  price_delta_cents: number;
  kind: OptionKind;
  active: boolean;
  display_order: number;
}

export interface StaffMenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  thumb_url: string | null;
  model_url: string | null;
  ingredients: string[];
  allergens: string[];
  price_cents: number;
  available: boolean;
  active: boolean;
  display_order: number;
  options: StaffMenuOption[];
}

export interface StaffMenuCategory {
  id: string;
  name: string;
  display_order: number;
  active: boolean;
  items: StaffMenuItem[];
}

export interface StaffMenu {
  categories: StaffMenuCategory[];
}

export interface RestaurantSettings {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo_url: string | null;
  cover_url: string | null;
  accent_color: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  whatsapp: string | null;
  maps_url: string | null;
  opening_hours: OpeningHours;
  theme: 'dark' | 'light';
  font: 'serif' | 'sans';
  is_demo: boolean;
  status: 'ativo' | 'suspenso' | 'desativado';
  accepting_orders: boolean;
  timezone: string;
  currency: string;
  service_fee_bps: number;
  menu_base_url: string | null;
}

/** Uma linha do registo de atividade da equipa, já em frase legível (sem IP nem dados técnicos). */
export interface ActivityEntry {
  id: string;
  at: string;
  actor_name: string | null;
  actor_role: string | null;
  text: string;
}

/** Contactos comerciais da Altiora Grupo (definidos na configuração do servidor). */
export interface CommercialContact {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
}

/** O plano do restaurante, o que inclui e o espaço de ficheiros usado (vista do gerente). */
export interface PlanOverview {
  plan: { code: string; name: string; tagline: string };
  status: 'ativa' | 'em_atraso' | 'cancelada';
  valid_until: string | null;
  features: FeatureKey[];
  storage: { used_bytes: number; quota_bytes: number };
}

// --- plataforma (Altiora Grupo) ------------------------------------------------------------------
export interface AdminRestaurant {
  id: string;
  name: string;
  slug: string;
  status: 'ativo' | 'suspenso' | 'desativado';
  created_at: string;
  menu_base_url: string | null;
  currency: string;
  is_demo: boolean;
  plan_code: string | null;
  subscription_status: 'ativa' | 'em_atraso' | 'cancelada' | null;
  valid_until: string | null;
  /** Nota interna da Altiora sobre a assinatura (nunca aparece ao restaurante). */
  subscription_notes: string | null;
  managers: Array<{ id: string; name: string; email: string }>;
}

export interface AdminPlanPrice {
  currency: string;
  monthly_cents: number;
  yearly_cents: number | null;
}

export interface AdminPlan {
  code: string;
  name: string;
  tagline: string;
  display_order: number;
  highlighted: boolean;
  active: boolean;
  features: FeatureKey[];
  prices: AdminPlanPrice[];
  restaurants: number;
}

export interface AdminLead {
  id: string;
  name: string;
  business: string;
  phone: string;
  email: string;
  message: string;
  status: 'novo' | 'contactado' | 'arquivado';
  created_at: string;
}

/** Utilização por restaurante: só números agregados (sem pedidos, clientes nem vendas). */
export interface AdminUsageRow {
  restaurant_id: string;
  tables_count: number;
  items_count: number;
  items_with_3d: number;
  orders_30d: number;
  assets_bytes: number;
  last_order_at: string | null;
  staff_count: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
  request_id?: string;
}

export type RealtimeEvent =
  | { type: 'hello'; at: string }
  | { type: 'order.created'; order_id: string; order_number: number; table_number: number; at: string }
  | { type: 'order.status'; order_id: string; order_number: number; table_number: number; from: OrderStatus; to: OrderStatus; at: string }
  | { type: 'menu.changed'; at: string }
  | { type: 'waiter.call'; call_id: string; table_number: number; table_label: string | null; at: string }
  | { type: 'waiter.call.done'; call_id: string; at: string };

// --- pagamentos ---------------------------------------------------------------------------------------
export interface PaymentView {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: number;
  status: PaymentStatus;
  reference: string | null;
  created_at: string;
  updated_at: string;
}

// --- equipa ------------------------------------------------------------------------------------------
export interface StaffMember {
  user_id: string;
  name: string;
  email: string;
  role: StaffRole;
  active: boolean;
  /** Ainda não trocou a palavra-passe temporária. */
  must_change_password: boolean;
  last_login_at: string | null;
  is_self: boolean;
}

// --- relatórios ----------------------------------------------------------------------------------------
export interface SalesReport {
  range: { from: string; to: string; timezone: string; currency: string };
  /** Vendas registadas: pedidos não cancelados. Não são dinheiro recebido. */
  sales: { orders: number; units: number; subtotal_cents: number; service_fee_cents: number; total_cents: number; average_ticket_cents: number };
  cancelled: { orders: number; total_cents: number };
  /** Pagamentos confirmados pela equipa (estado "pago"), pela data do registo. */
  payments: {
    confirmed_cents: number;
    refunded_cents: number;
    by_method: Array<{ method: PaymentMethod; count: number; confirmed_cents: number }>;
  };
  /** Dos pedidos do período, quanto ainda não foi recebido (exclui cancelados e isentos). */
  outstanding_cents: number;
  exempt_orders: number;
  by_day: Array<{ day: string; orders: number; total_cents: number; confirmed_cents: number }>;
  top_items: Array<{ name: string; quantity: number; total_cents: number }>;
}
