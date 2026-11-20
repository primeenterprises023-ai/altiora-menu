// Palavras-passe: guardadas apenas como "hash" scrypt (memória-intensivo), nunca em claro.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { Semaphore } from '../lib/semaphore';

const KEYLEN = 32;
const R = 8;
const P = 1;

// o scrypt usa ~32 MB por cálculo: no máximo 4 ao mesmo tempo (evita esgotar a memória com muitos inícios de sessão)
const gate = new Semaphore(4);

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  return gate.run(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scryptCb(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 4 * 1024 * 1024 }, (err, key) =>
          err ? reject(err) : resolve(key),
        );
      }),
  );
}

/** Formato guardado: scrypt$<logN>$<r>$<p>$<sal>$<hash> (parâmetros incluídos para permitir upgrades futuros). */
export async function hashPassword(password: string, logN = 15): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, logN, R, P);
  return `scrypt$${logN}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || logN < 10 || logN > 20 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return false;
  try {
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    const actual = await derive(password, salt, logN, r, p);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou12', 'admin12345',
  'administrador', 'senha12345', 'senha123456', 'palavrapasse', 'altiora123', 'altiora2026', 'restaurante', 'restaurante1',
  'abcdefghij', '0123456789', '1q2w3e4r5t', 'welcome123', 'letmein123', 'luanda2026', 'angola2026', 'angola12345',
]);

/** Devolve uma mensagem de erro (em português) ou null se a palavra-passe for aceitável. */
export function checkPasswordStrength(password: string, email?: string): string | null {
  if (password.length < 10) return 'A palavra-passe deve ter pelo menos 10 caracteres.';
  if (password.length > 128) return 'A palavra-passe pode ter no máximo 128 caracteres.';
  if (new Set(password).size < 5) return 'A palavra-passe é demasiado repetitiva.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'Esta palavra-passe é demasiado comum. Escolha outra.';
  if (email) {
    const e = email.toLowerCase();
    const local = e.split('@')[0] ?? '';
    if (lower === e || (local.length >= 4 && lower.includes(local))) return 'A palavra-passe não pode conter o seu e-mail.';
  }
  return null;
}
