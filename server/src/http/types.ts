import type { ZodType } from 'zod';
import type { Config } from '../config';
import type { Database, DbContext } from '../db/client';
import type { Logger } from '../lib/log';
import type { Hub } from './hub';
import type { LoginThrottle, RateLimiter } from './rate-limit';
import type { OriginPolicy } from './security';
import type { StaffRole } from '../../../shared/status';

export interface Deps {
  config: Config;
  db: Database;
  hub: Hub;
  limiter: RateLimiter;
  loginThrottle: LoginThrottle;
  log: Logger;
  origins: OriginPolicy;
}

/** Sessão autenticada (carregada da base de dados a cada pedido). */
export interface AuthInfo {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  role: StaffRole | 'platform';
  mustChangePassword: boolean;
  restaurantId: string | null;
  restaurantName: string | null;
  restaurantSlug: string | null;
  restaurantStatus: string | null;
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
  requestId: string;
  deps: Deps;
  auth: AuthInfo | null;
  /** Lê e valida o corpo JSON. */
  body<T>(schema: ZodType<T, any, any>): Promise<T>;
  /** Lê o corpo como bytes (só para o envio de ficheiros). */
  bytes(maxBytes: number): Promise<Uint8Array>;
  /** Contexto de base de dados do utilizador autenticado. */
  dbContext(extra?: Partial<DbContext>): DbContext;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

export type Access = 'public' | 'session' | 'platform' | { roles: ReadonlyArray<StaffRole> };

export interface RateRule {
  /** Nome do contador (diferente para cada regra). */
  name: string;
  max: number;
  windowMs: number;
}

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  access: Access;
  handler: Handler;
  /** Limites por IP aplicados antes do handler. */
  limits?: RateRule[];
  /** A rota funciona mesmo com a conta do restaurante suspensa (ex.: terminar sessão). */
  allowSuspended?: boolean;
  /** A rota funciona enquanto a palavra-passe temporária não for trocada. */
  allowMustChange?: boolean;
  /** O corpo não é JSON (não exige Content-Type: application/json). */
  noBody?: boolean;
}
