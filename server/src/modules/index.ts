import type { RouteSpec } from '../http/types';
import { activityRoutes } from './activity/routes';
import { adminRoutes } from './admin/routes';
import { billingRoutes } from './admin/billing';
import { assetRoutes } from './assets/routes';
import { authRoutes } from './auth/routes';
import { callRoutes } from './calls/routes';
import { leadRoutes } from './leads/routes';
import { menuRoutes } from './menu/routes';
import { orderRoutes } from './orders/routes';
import { paymentRoutes } from './payments/routes';
import { publicRoutes } from './public/routes';
import { qrRoutes } from './qr/routes';
import { reportRoutes } from './reports/routes';
import { restaurantRoutes } from './restaurants/routes';
import { staffRoutes } from './staff/routes';
import { systemRoutes } from './system/routes';
import { tableRoutes } from './tables/routes';

export const allRoutes: RouteSpec[] = [
  ...systemRoutes,
  ...publicRoutes,
  ...authRoutes,
  ...assetRoutes,
  ...orderRoutes,
  ...paymentRoutes,
  ...staffRoutes,
  ...reportRoutes,
  ...activityRoutes,
  ...tableRoutes,
  ...menuRoutes,
  ...restaurantRoutes,
  ...adminRoutes,
  ...billingRoutes,
  ...callRoutes,
  ...qrRoutes,
  ...leadRoutes,
];
