// Pedidos à API da equipa, com os tipos certos. Mantém as páginas curtas e os caminhos num só sítio.
import type { OrderStatus } from '../../../shared/status';
import type { PaymentMethod } from '../../../shared/payments';
import type { Currency, FeatureInfo, FeatureKey } from '../../../shared/plans';
import type { ActivityEntry, AdminLead, AdminPlan, AdminRestaurant, AdminUsageRow, CommercialContact, PlanOverview, OrderView, PaymentView, RestaurantSettings, SalesReport, StaffMember, StaffMenu, StaffMenuItem, StaffTable, WaiterCallView } from '../../../shared/types';
import type { OrderPaymentSummary } from '../../../shared/payments';
import { api } from '../lib/api';

export interface OrdersResponse {
  server_time: string;
  orders: OrderView[];
}

export interface OrderHistoryEntry {
  previous_status: OrderStatus | null;
  new_status: OrderStatus;
  changed_by_role: string | null;
  reason: string | null;
  created_at: string;
}

export interface PaymentsResponse {
  payments: PaymentView[];
  summary: OrderPaymentSummary;
  total_cents: number;
}

export interface OrderQuery {
  scope?: 'active' | 'history';
  status?: OrderStatus[];
  unpaid?: boolean;
  tableId?: string;
  before?: string;
  limit?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? `?${q}` : '';
}

export const orders = {
  list: (q: OrderQuery, signal?: AbortSignal) =>
    api.get<OrdersResponse>(
      `/api/orders${query({ scope: q.scope, status: q.status?.join(','), unpaid: q.unpaid ? '1' : undefined, table_id: q.tableId, before: q.before, limit: q.limit })}`,
      { signal },
    ),
  detail: (id: string, signal?: AbortSignal) => api.get<{ order: OrderView; history: OrderHistoryEntry[] }>(`/api/orders/${id}`, { signal }),
  changeStatus: (id: string, body: { to: OrderStatus; from?: OrderStatus; reason?: string }) => api.post<{ order: OrderView }>(`/api/order-status/${id}`, body),
  /** Com a mesma `idempotencyKey`, repetir o envio devolve o pedido já criado (em vez de criar outro). */
  createManual: (
    body: { table_id: string; items: Array<{ menu_item_id: string; quantity: number; notes?: string; options: Array<{ option_id: string; quantity: number }> }>; notes?: string },
    idempotencyKey: string,
  ) => api.post<{ order: OrderView; replayed?: boolean }>('/api/orders', body, { headers: { 'Idempotency-Key': idempotencyKey } }),
};

export const calls = {
  list: (signal?: AbortSignal) => api.get<{ server_time: string; calls: WaiterCallView[] }>('/api/staff/waiter-calls', { signal }),
  attend: (id: string) => api.post<{ call: WaiterCallView }>(`/api/staff/waiter-calls/${id}/attend`),
};

export const payments = {
  list: (orderId: string, signal?: AbortSignal) => api.get<PaymentsResponse>(`/api/orders/${orderId}/payments`, { signal }),
  record: (orderId: string, body: { method: PaymentMethod; status?: 'pago' | 'isento'; amount_cents?: number; reference?: string }) =>
    api.post<{ payment: PaymentView; summary: OrderPaymentSummary }>(`/api/orders/${orderId}/payments`, body),
  change: (paymentId: string, body: { status: 'reembolsado' | 'anulado'; reason: string }) =>
    api.patch<{ payment: PaymentView; summary: OrderPaymentSummary }>(`/api/payments/${paymentId}`, body),
};

export const tables = {
  list: (signal?: AbortSignal) => api.get<{ tables: StaffTable[] }>('/api/tables', { signal }),
  create: (body: { table_number: number; label?: string | null }) => api.post<{ table: StaffTable }>('/api/tables', body),
  update: (id: string, body: { label?: string | null; active?: boolean }) => api.patch<{ table: StaffTable }>(`/api/tables/${id}`, body),
  regenerateQr: (id: string) => api.post<{ table: StaffTable }>(`/api/tables/${id}/regenerate-qr`),
  remove: (id: string) => api.del<void>(`/api/tables/${id}`),
  closeSession: (id: string) => api.post<{ closed: boolean }>(`/api/tables/${id}/close-session`),
};

export const menu = {
  get: (signal?: AbortSignal) => api.get<StaffMenu>('/api/menu', { signal }),
  setAvailability: (itemId: string, available: boolean) => api.patch<{ item: StaffMenuItem }>(`/api/menu/items/${itemId}/availability`, { available }),
  createCategory: (body: { name: string; display_order?: number; active?: boolean }) => api.post('/api/menu/categories', body),
  updateCategory: (id: string, body: { name?: string; display_order?: number; active?: boolean }) => api.patch(`/api/menu/categories/${id}`, body),
  deleteCategory: (id: string) => api.del<void>(`/api/menu/categories/${id}`),
  createItem: (body: Record<string, unknown>) => api.post<{ item: StaffMenuItem }>('/api/menu/items', body),
  updateItem: (id: string, body: Record<string, unknown>) => api.patch<{ item: StaffMenuItem }>(`/api/menu/items/${id}`, body),
  deleteItem: (id: string) => api.del<void>(`/api/menu/items/${id}`),
  createOption: (itemId: string, body: { name: string; price_delta_cents?: number; kind?: 'extra' | 'size'; active?: boolean; display_order?: number }) => api.post(`/api/menu/items/${itemId}/options`, body),
  updateOption: (id: string, body: { name?: string; price_delta_cents?: number; kind?: 'extra' | 'size'; active?: boolean; display_order?: number }) => api.patch(`/api/menu/options/${id}`, body),
  deleteOption: (id: string) => api.del<void>(`/api/menu/options/${id}`),
};

export interface UploadedAsset {
  id: string;
  /** Endereço a guardar no prato ou no restaurante (/a/<id>). */
  url: string;
  kind: 'image' | 'model';
  content_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
}

/** Fotografias e modelos 3D do restaurante (só o gerente envia). */
export const assets = {
  upload: (file: Blob, signal?: AbortSignal) => api.post<{ asset: UploadedAsset }>('/api/assets', file, { signal }),
};

/** O plano do restaurante, o que inclui e o espaço usado. */
export const plan = {
  get: (signal?: AbortSignal) => api.get<{ plan: PlanOverview; catalog: FeatureInfo[]; contact: CommercialContact }>('/api/restaurants/current/plan', { signal }),
};

export const restaurant = {
  current: (signal?: AbortSignal) => api.get<{ restaurant: RestaurantSettings }>('/api/restaurants/current', { signal }),
  update: (body: Record<string, unknown>) => api.patch<{ restaurant: RestaurantSettings }>('/api/restaurants/current', body),
};

export const team = {
  list: (signal?: AbortSignal) => api.get<{ members: StaffMember[] }>('/api/staff', { signal }),
  create: (body: { name: string; email: string; role: 'manager' | 'waiter' | 'kitchen' }) => api.post<{ member: StaffMember; temporary_password: string }>('/api/staff', body),
  update: (userId: string, body: { role?: 'manager' | 'waiter' | 'kitchen'; active?: boolean }) => api.patch<{ member: StaffMember }>(`/api/staff/${userId}`, body),
  resetPassword: (userId: string) => api.post<{ email: string; temporary_password: string }>(`/api/staff/${userId}/reset-password`),
};

export const reports = {
  sales: (from?: string, to?: string, signal?: AbortSignal) => api.get<{ report: SalesReport }>(`/api/reports/sales${query({ from, to })}`, { signal }),
  /** O ficheiro CSV é montado no servidor (só com "Gestão avançada" no plano) e descarregado com `downloadFile`. */
  csvPath: (from: string, to: string) => `/api/reports/sales.csv${query({ from, to })}`,
};

export const activity = {
  list: (before?: string, signal?: AbortSignal) => api.get<{ entries: ActivityEntry[]; next_before: string | null }>(`/api/activity${query({ before })}`, { signal }),
};

// --- plataforma (Altiora Grupo): só restaurantes e gerentes; nunca pedidos, menus ou pagamentos ---------------------
export type AdminStatus = AdminRestaurant['status'];

export interface AdminAuditEntry {
  id: string;
  restaurant_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AdminPlanBody {
  name: string;
  tagline: string;
  display_order: number;
  highlighted: boolean;
  active: boolean;
  features: FeatureKey[];
  prices: Array<{ currency: Currency; monthly_cents: number; yearly_cents: number | null }>;
}

export interface AdminSubscriptionBody {
  plan_code?: string;
  status?: 'ativa' | 'em_atraso' | 'cancelada';
  valid_until?: string | null;
  notes?: string | null;
}

export const admin = {
  list: (signal?: AbortSignal) => api.get<{ restaurants: AdminRestaurant[] }>('/api/admin/restaurants', { signal }),
  create: (body: { name: string; slug?: string; plan_code?: string; currency?: Currency; manager: { name: string; email: string } }) =>
    api.post<{ restaurant: AdminRestaurant; manager: { email: string; existing_account: boolean; temporary_password: string | null } }>('/api/admin/restaurants', body),
  update: (id: string, body: { name?: string; status?: AdminStatus }) => api.patch<{ restaurant: AdminRestaurant }>(`/api/admin/restaurants/${id}`, body),
  resetManagerPassword: (restaurantId: string, userId: string) =>
    api.post<{ manager: { email: string; temporary_password: string } }>(`/api/admin/restaurants/${restaurantId}/managers/${userId}/reset-password`),
  audit: (signal?: AbortSignal) => api.get<{ entries: AdminAuditEntry[] }>('/api/admin/audit', { signal }),

  // planos e preços (definidos pela Altiora; não há pagamentos no sistema)
  plans: (signal?: AbortSignal) => api.get<{ plans: AdminPlan[] }>('/api/admin/plans', { signal }),
  createPlan: (body: AdminPlanBody & { code: string }) => api.post<{ plan: AdminPlan }>('/api/admin/plans', body),
  updatePlan: (code: string, body: Partial<AdminPlanBody>) => api.patch<{ plan: AdminPlan }>(`/api/admin/plans/${code}`, body),
  // assinatura de um restaurante: plano, estado e validade (só informação)
  updateSubscription: (restaurantId: string, body: AdminSubscriptionBody) => api.patch<{ subscription: unknown }>(`/api/admin/restaurants/${restaurantId}/subscription`, body),
  // utilização: só contagens
  usage: (signal?: AbortSignal) => api.get<{ usage: AdminUsageRow[]; generated_at: string }>('/api/admin/usage', { signal }),
  // pedidos de contacto da página comercial
  leads: (signal?: AbortSignal) => api.get<{ leads: AdminLead[] }>('/api/admin/leads', { signal }),
  setLeadStatus: (id: string, status: AdminLead['status']) => api.patch<{ lead: AdminLead }>(`/api/admin/leads/${id}`, { status }),
  deleteLead: (id: string) => api.del<void>(`/api/admin/leads/${id}`),
};
