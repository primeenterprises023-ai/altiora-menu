// Converte erros inesperados (base de dados, validação) em respostas de erro claras e seguras.
// As mensagens técnicas NUNCA chegam ao cliente: só um código e uma frase em português.
import { ZodError } from 'zod';
import { pgCode, pgConstraint } from '../db/client';
import { HttpError } from '../lib/errors';
import { zodDetails } from '../lib/zod-pt';

const CONSTRAINT_MESSAGES: Record<string, string> = {
  restaurant_tables_number_uq: 'Já existe uma mesa com este número.',
  categories_name_uq: 'Já existe uma categoria com este nome.',
  users_email_uq: 'Já existe uma conta com este e-mail.',
  restaurants_slug_uq: 'Este endereço (slug) já está em uso.',
  restaurant_members_uq: 'Esta pessoa já faz parte da equipa.',
  orders_idem_uq: 'Este pedido já foi enviado.',
};

export interface MappedError {
  error: HttpError;
  /** Deve ser registado como erro do servidor (não é uma falha normal do cliente)? */
  serverFault: boolean;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof HttpError) return { error: err, serverFault: err.status >= 500 };

  if (err instanceof ZodError) {
    return { error: new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos.', zodDetails(err)), serverFault: false };
  }

  const code = pgCode(err);
  if (code) {
    const constraint = pgConstraint(err);
    switch (code) {
      case 'AL001':
        return { error: new HttpError(409, 'INVALID_TRANSITION', 'Esta alteração de estado não é permitida.'), serverFault: false };
      case 'AL002':
        return { error: new HttpError(422, 'REASON_REQUIRED', 'Indique o motivo desta alteração.'), serverFault: false };
      case 'AL003':
        return { error: new HttpError(409, 'ORDER_IMMUTABLE', 'Os dados de um pedido não podem ser alterados.'), serverFault: false };
      case 'AL004':
        return { error: new HttpError(404, 'RESTAURANT_NOT_FOUND', 'Restaurante não encontrado.'), serverFault: false };
      case 'AL005':
        return { error: new HttpError(422, 'INVALID_TIMEZONE', 'Fuso horário inválido (exemplo: Africa/Luanda).'), serverFault: false };
      case 'AL006':
        return { error: new HttpError(404, 'TABLE_NOT_FOUND', 'Mesa não encontrada.'), serverFault: false };
      case '23505':
        return {
          error: new HttpError(409, 'DUPLICATE', (constraint && CONSTRAINT_MESSAGES[constraint]) || 'Já existe um registo com estes dados.'),
          serverFault: false,
        };
      case '23503':
        return { error: new HttpError(409, 'REFERENCE_CONFLICT', 'Esta operação não é possível porque existem dados associados.'), serverFault: false };
      case '23514':
      case '23502':
      case '22001':
      case '22003':
        return { error: new HttpError(422, 'INVALID_DATA', 'Os dados indicados não são válidos.'), serverFault: false };
      case '22P02':
      case '22007':
      case '22008':
      case '22021':
        return { error: new HttpError(400, 'BAD_REQUEST', 'Pedido inválido.'), serverFault: false };
      case '42501':
        // recusado pela base de dados (RLS ou permissões): nunca deveria acontecer em uso normal
        return { error: new HttpError(403, 'FORBIDDEN', 'Não tem permissão para esta operação.'), serverFault: true };
      case '57014':
        return { error: new HttpError(503, 'DB_TIMEOUT', 'O servidor está ocupado. Tente novamente dentro de instantes.', undefined, { 'retry-after': '3' }), serverFault: true };
      case '40001':
      case '40P01':
        return { error: new HttpError(503, 'DB_CONFLICT', 'Operação em conflito. Tente novamente.', undefined, { 'retry-after': '1' }), serverFault: false };
      default:
        break;
    }
  }

  // sem ligação à base de dados (ou ligação interrompida)
  const e = err as { code?: unknown; message?: unknown } | null;
  const sysCode = e && typeof e.code === 'string' ? e.code : '';
  if (!code && (sysCode.startsWith('ERR_POSTGRES_') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(sysCode))) {
    return { error: new HttpError(503, 'DB_UNAVAILABLE', 'O serviço está temporariamente indisponível. Tente novamente dentro de instantes.', undefined, { 'retry-after': '5' }), serverFault: true };
  }

  return { error: new HttpError(500, 'INTERNAL_ERROR', 'Ocorreu um erro inesperado. Tente novamente.'), serverFault: true };
}
