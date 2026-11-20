import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token aleatório seguro em base64url. 16 bytes (128 bits) => 22 caracteres. */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comparação em tempo constante. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Palavra-passe temporária legível (sem caracteres ambíguos), p. ex. para contas novas. */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const limit = 256 - (256 % alphabet.length); // descarta valores que tornariam alguns caracteres mais prováveis
  let out = '';
  while (out.length < 14) {
    for (const b of randomBytes(32)) {
      if (b < limit && out.length < 14) out += alphabet[b % alphabet.length];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 9)}-${out.slice(9)}`;
}
