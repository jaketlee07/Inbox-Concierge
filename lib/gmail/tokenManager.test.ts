import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    DB_ENCRYPTION_KEY: 'a'.repeat(32),
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost',
    SUPABASE_SERVICE_ROLE_KEY: 'sr',
  },
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^enc:/, '')),
}));

type SelectResult = { data: unknown; error: unknown };
type UpdateResult = { error: unknown };

const mockState: {
  selectResult: SelectResult;
  updateResult: UpdateResult;
  updatePayload: Record<string, unknown> | null;
  updateUserIdEq: string | null;
} = {
  selectResult: { data: null, error: null },
  updateResult: { error: null },
  updatePayload: null,
  updateUserIdEq: null,
};

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve(mockState.selectResult),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        mockState.updatePayload = payload;
        return {
          eq: (_col: string, val: string) => {
            mockState.updateUserIdEq = val;
            return Promise.resolve(mockState.updateResult);
          },
        };
      },
    }),
  })),
}));

const NOW = new Date('2026-04-28T12:00:00.000Z').getTime();

function bytea(plaintext: string): string {
  // Mirrors the new crypto.ts transport format: \x-prefixed hex.
  return `enc:${plaintext}`;
}

function makeRow(overrides: {
  access_token?: string | null;
  refresh_token?: string;
  expires_at?: string | null;
}) {
  return {
    access_token:
      overrides.access_token === undefined ? bytea('cached-at') : overrides.access_token,
    refresh_token: overrides.refresh_token ?? bytea('refresh-x'),
    expires_at: overrides.expires_at ?? new Date(NOW + 60 * 60 * 1000).toISOString(),
  };
}

function mockFetch(response: { status: number; body: unknown }) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getAccessToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockState.selectResult = { data: null, error: null };
    mockState.updateResult = { error: null };
    mockState.updatePayload = null;
    mockState.updateUserIdEq = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns cached access token when not near expiry', async () => {
    mockState.selectResult = {
      data: makeRow({ expires_at: new Date(NOW + 60 * 60 * 1000).toISOString() }),
      error: null,
    };
    const fetchMock = mockFetch({ status: 200, body: {} });

    const { getAccessToken } = await import('./tokenManager');
    const token = await getAccessToken('u1');

    expect(token).toBe('cached-at');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockState.updatePayload).toBeNull();
  });

  it('refreshes when access token is inside the 5-minute buffer', async () => {
    mockState.selectResult = {
      data: makeRow({ expires_at: new Date(NOW + 4 * 60 * 1000).toISOString() }),
      error: null,
    };
    const fetchMock = mockFetch({
      status: 200,
      body: { access_token: 'new-at', expires_in: 3600 },
    });

    const { getAccessToken } = await import('./tokenManager');
    const token = await getAccessToken('u1');

    expect(token).toBe('new-at');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=test-client-id');
    expect(body).toContain('client_secret=test-client-secret');
    expect(body).toContain('refresh_token=refresh-x');

    expect(mockState.updateUserIdEq).toBe('u1');
    expect(mockState.updatePayload).not.toBeNull();
    const payload = mockState.updatePayload as { access_token: string; expires_at: string };
    expect(payload.access_token).toBe('enc:new-at');
    expect(Date.parse(payload.expires_at)).toBe(NOW + 3600 * 1000);
  });

  it('refreshes when access token is already expired', async () => {
    mockState.selectResult = {
      data: makeRow({ expires_at: new Date(NOW - 60 * 1000).toISOString() }),
      error: null,
    };
    const fetchMock = mockFetch({
      status: 200,
      body: { access_token: 'fresh-at', expires_in: 3600 },
    });

    const { getAccessToken } = await import('./tokenManager');
    const token = await getAccessToken('u1');

    expect(token).toBe('fresh-at');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockState.updatePayload).not.toBeNull();
  });

  it('throws OAuthRevokedError on invalid_grant from Google', async () => {
    mockState.selectResult = {
      data: makeRow({ expires_at: new Date(NOW - 60 * 1000).toISOString() }),
      error: null,
    };
    mockFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token revoked' },
    });

    const { getAccessToken } = await import('./tokenManager');
    const { OAuthRevokedError } = await import('@/lib/errors');

    await expect(getAccessToken('u1')).rejects.toBeInstanceOf(OAuthRevokedError);
    expect(mockState.updatePayload).toBeNull();
  });

  it('throws when no oauth_tokens row exists for user', async () => {
    mockState.selectResult = { data: null, error: { code: 'PGRST116' } };
    mockFetch({ status: 200, body: {} });

    const { getAccessToken } = await import('./tokenManager');
    await expect(getAccessToken('u-missing')).rejects.toMatchObject({
      code: 'OAUTH_TOKEN_MISSING',
      statusCode: 401,
    });
  });

  it('returns the new access token even when DB persist fails', async () => {
    mockState.selectResult = {
      data: makeRow({ expires_at: new Date(NOW - 60 * 1000).toISOString() }),
      error: null,
    };
    mockState.updateResult = { error: { message: 'boom' } };
    mockFetch({
      status: 200,
      body: { access_token: 'still-good', expires_in: 3600 },
    });

    const { getAccessToken } = await import('./tokenManager');
    const token = await getAccessToken('u1');
    expect(token).toBe('still-good');
  });

  it('throws on non-200, non-invalid_grant response from Google', async () => {
    mockState.selectResult = {
      data: makeRow({ expires_at: new Date(NOW - 60 * 1000).toISOString() }),
      error: null,
    };
    mockFetch({ status: 500, body: { error: 'server_error' } });

    const { getAccessToken } = await import('./tokenManager');
    await expect(getAccessToken('u1')).rejects.toMatchObject({
      code: 'GMAIL_TOKEN_REFRESH_FAILED',
      statusCode: 502,
    });
  });
});
