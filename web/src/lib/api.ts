// Cliente da API: pedidos JSON ao servidor, com erros claros em português e tratamento de sessão terminada.
import type { ApiErrorBody } from '../../../shared/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Sem resposta do servidor (sem internet, servidor em baixo ou demorou demasiado). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export interface ApiHooks {
  /** A sessão terminou ou não existe (401) num pedido autenticado. */
  onUnauthorized?: (err: ApiError) => void;
  /** A conta tem de trocar a palavra-passe temporária. */
  onPasswordChangeRequired?: () => void;
}
let hooks: ApiHooks = {};
export function setApiHooks(next: ApiHooks): void {
  hooks = next;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Não aciona o tratamento global de sessão terminada (usado no início de sessão). */
  quiet?: boolean;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const NETWORK_MESSAGE = 'Sem ligação ao servidor. Verifique a internet e tente novamente.';

function fromResponse(res: Response, body: unknown): ApiError {
  const retry = Number(res.headers.get('retry-after'));
  const retryAfterSec = Number.isFinite(retry) && retry > 0 ? retry : undefined;
  const b = body as Partial<ApiErrorBody> | null;
  if (b && typeof b === 'object' && b.error && typeof b.error.code === 'string') {
    return new ApiError(res.status, b.error.code, String(b.error.message ?? 'Ocorreu um erro.'), b.error.details, b.request_id, retryAfterSec);
  }
  const message =
    res.status >= 500
      ? 'O serviço está temporariamente indisponível. Tente novamente dentro de instantes.'
      : res.status === 404
        ? 'Não encontrado.'
        : 'Não foi possível concluir o pedido.';
  return new ApiError(res.status, `HTTP_${res.status}`, message, undefined, undefined, retryAfterSec);
}

export async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  // um ficheiro (fotografia ou modelo 3D) é enviado tal como está; o resto vai em JSON
  const isFile = typeof Blob !== 'undefined' && body instanceof Blob;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? (isFile ? 90_000 : 20_000));
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let payload: string | Blob | undefined;
  if (body !== undefined) {
    if (isFile) {
      headers['content-type'] = (body as Blob).type || 'application/octet-stream';
      payload = body as Blob;
    } else {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
  } catch (err) {
    if (opts.signal?.aborted) throw err; // cancelado por quem pediu: não é um erro de rede
    if (timedOut) throw new ApiError(0, 'TIMEOUT', 'O servidor demorou demasiado a responder. Tente novamente.');
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_MESSAGE);
  } finally {
    window.clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  const type = res.headers.get('content-type') ?? '';
  try {
    data = type.includes('json') ? await res.json() : await res.text();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = fromResponse(res, data);
    if (!opts.quiet) {
      if (err.status === 401) hooks.onUnauthorized?.(err);
      else if (err.code === 'PASSWORD_CHANGE_REQUIRED') hooks.onPasswordChangeRequired?.();
    }
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

export function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

/** Mensagem pronta a mostrar a uma pessoa. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Ocorreu um erro inesperado. Tente novamente.';
}
