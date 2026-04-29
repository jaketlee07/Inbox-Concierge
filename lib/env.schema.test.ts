import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.schema';

const validEnv = {
  NODE_ENV: 'test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'upstash-token',
  DB_ENCRYPTION_KEY: 'a'.repeat(32),
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

describe('parseEnv', () => {
  it('accepts a fully valid env', () => {
    const env = parseEnv(validEnv);
    expect(env.NODE_ENV).toBe('test');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
  });

  it('throws when a required var is missing', () => {
    const { ANTHROPIC_API_KEY: _omit, ...missing } = validEnv;
    expect(() => parseEnv(missing)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('rejects an Anthropic key without the sk-ant- prefix', () => {
    expect(() => parseEnv({ ...validEnv, ANTHROPIC_API_KEY: 'sk-bad' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('rejects a DB_ENCRYPTION_KEY shorter than 32 chars', () => {
    expect(() => parseEnv({ ...validEnv, DB_ENCRYPTION_KEY: 'short' })).toThrow(
      /DB_ENCRYPTION_KEY/,
    );
  });

  it('rejects a non-URL Supabase URL', () => {
    expect(() => parseEnv({ ...validEnv, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
  });
});
