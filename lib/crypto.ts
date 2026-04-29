import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env';

// Env value is ≥32 chars but not guaranteed binary-safe or fixed length.
// SHA-256 normalizes it to a stable 32-byte key suitable for AES-256.
const KEY = createHash('sha256').update(env.DB_ENCRYPTION_KEY).digest();
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// Returns a Postgres bytea literal (\x-prefixed hex). Buffers don't survive
// supabase-js's JSON.stringify — they serialize as {type:'Buffer',data:[...]}
// which PostgREST silently mis-stores. Hex-string is the safe transport.
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return '\\x' + Buffer.concat([iv, ciphertext, tag]).toString('hex');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload.startsWith('\\x') ? payload.slice(2) : payload, 'hex');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
