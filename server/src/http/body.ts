// Leitura segura do corpo dos pedidos (JSON com tamanho máximo).
import { HttpError } from '../lib/errors';

export const MAX_JSON_BYTES = 64 * 1024;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Lê o corpo como bytes (envio de fotografias e modelos 3D), com tamanho máximo. */
export async function readBytesBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'O ficheiro é demasiado grande.');
  if (!req.body) throw new HttpError(400, 'EMPTY_BODY', 'Não foi enviado nenhum ficheiro.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'O ficheiro é demasiado grande.');
    }
    chunks.push(value);
  }
  if (total === 0) throw new HttpError(400, 'EMPTY_BODY', 'Não foi enviado nenhum ficheiro.');
  return concat(chunks, total);
}

export async function readJsonBody(req: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const contentType = (req.headers.get('content-type') ?? '').trim();
  if (!/^application\/json\s*(;.*)?$/i.test(contentType)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'O pedido deve ser enviado em JSON (Content-Type: application/json).');
  }
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'O pedido é demasiado grande.');
  }
  if (!req.body) throw new HttpError(400, 'INVALID_JSON', 'O corpo do pedido está vazio.');

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'O pedido é demasiado grande.');
    }
    chunks.push(value);
  }
  if (total === 0) throw new HttpError(400, 'INVALID_JSON', 'O corpo do pedido está vazio.');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(concat(chunks, total));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'O corpo do pedido não é texto UTF-8 válido.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'O corpo do pedido não é JSON válido.');
  }
}
