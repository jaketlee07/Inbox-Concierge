import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    DB_ENCRYPTION_KEY: 'a'.repeat(32),
  },
}));

const { encrypt, decrypt } = await import('./crypto');

describe('crypto', () => {
  it('round-trips a plaintext through encrypt/decrypt', () => {
    const plaintext = 'ya29.a0ARrdaM-fake-google-token';
    const encoded = encrypt(plaintext);
    expect(decrypt(encoded)).toBe(plaintext);
  });

  it('produces a Postgres bytea literal (\\x-prefixed hex)', () => {
    const encoded = encrypt('hello');
    expect(encoded.startsWith('\\x')).toBe(true);
    expect(encoded.slice(2)).toMatch(/^[0-9a-f]+$/);
  });

  it('encrypts the same plaintext to different ciphertexts (random IV)', () => {
    const a = encrypt('same input');
    const b = encrypt('same input');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same input');
    expect(decrypt(b)).toBe('same input');
  });

  it('handles unicode and long inputs', () => {
    const long = 'r'.repeat(2048);
    const unicode = 'résumé 🛡 — Ω';
    expect(decrypt(encrypt(long))).toBe(long);
    expect(decrypt(encrypt(unicode))).toBe(unicode);
  });

  it('throws when the ciphertext has been tampered with', () => {
    const encoded = encrypt('sensitive');
    // Flip one nibble in the middle of the hex payload.
    const corrupted = encoded.slice(0, 30) + (encoded[30] === '0' ? '1' : '0') + encoded.slice(31);
    expect(() => decrypt(corrupted)).toThrow();
  });

  it('accepts hex without the \\x prefix (defensive)', () => {
    const encoded = encrypt('hi');
    const noPrefix = encoded.slice(2);
    expect(decrypt(noPrefix)).toBe('hi');
  });
});
