// Erros HTTP consistentes. Todas as respostas de erro têm o formato:
//   { "error": { "code": "...", "message": "...", "details": ... }, "request_id": "..." }

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown, code = 'BAD_REQUEST') => new HttpError(400, code, message, details);
export const unauthorized = (message = 'É necessário iniciar sessão.', code = 'UNAUTHENTICATED') => new HttpError(401, code, message);
export const forbidden = (message = 'Não tem permissão para esta operação.', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = 'Não encontrado.', code = 'NOT_FOUND') => new HttpError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) => new HttpError(409, code, message, details);
export const unprocessable = (message: string, code = 'UNPROCESSABLE', details?: unknown) => new HttpError(422, code, message, details);
export const tooMany = (message: string, retryAfterSec: number, code = 'RATE_LIMITED') =>
  new HttpError(429, code, message, undefined, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) });
