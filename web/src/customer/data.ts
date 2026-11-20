import type { PlaceOrderResponse, PublicMenu, PublicOrderSummary, PublicOrderView, WaiterCallPublic } from '../../../shared/types';
import { api } from '../lib/api';

export interface OrderPayload {
  items: Array<{ menu_item_id: string; quantity: number; notes?: string; options: Array<{ option_id: string; quantity: number }> }>;
  notes?: string;
}

export const publicApi = {
  menu: (token: string, signal?: AbortSignal) => api.get<PublicMenu>(`/api/public/menu/${encodeURIComponent(token)}`, { signal }),
  sessionOrders: (token: string, signal?: AbortSignal) => api.get<{ orders: PublicOrderSummary[] }>(`/api/public/menu/${encodeURIComponent(token)}/orders`, { signal }),
  placeOrder: (token: string, body: OrderPayload, idempotencyKey: string) =>
    api.post<PlaceOrderResponse>(`/api/public/menu/${encodeURIComponent(token)}/orders`, body, { headers: { 'Idempotency-Key': idempotencyKey } }),
  order: (code: string, signal?: AbortSignal) => api.get<{ order: PublicOrderView }>(`/api/public/orders/${encodeURIComponent(code)}`, { signal }),
};

export const LAST_MENU_KEY = 'altiora:last-menu';

export const waiterApi = {
  call: (token: string) => api.post<{ call: WaiterCallPublic }>(`/api/public/menu/${encodeURIComponent(token)}/call-waiter`, {}),
  cancel: (token: string) => api.post<{ cancelled: number }>(`/api/public/menu/${encodeURIComponent(token)}/call-waiter/cancel`, {}),
};

export const restaurantApi = {
  menu: (slug: string, signal?: AbortSignal) => api.get<PublicMenu>(`/api/public/restaurants/${encodeURIComponent(slug)}`, { signal }),
};
