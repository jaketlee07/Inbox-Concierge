import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// --- Mocks (must be hoisted before any unit-under-test import) ---

const supabaseAuth = { getUser: vi.fn<() => Promise<unknown>>() };
const supabaseUpsert = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const classificationsEq = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const supabaseFrom = vi.fn((table: string) => {
  if (table === 'classifications') {
    return { select: () => ({ eq: classificationsEq }) };
  }
  return { upsert: supabaseUpsert };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: supabaseAuth,
    from: supabaseFrom,
  })),
}));

const limiterLimit = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/ratelimit', () => ({
  gmailFetchLimiter: { limit: (...args: unknown[]) => limiterLimit(...args) },
}));

const clientList = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const clientGet = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/gmail/client', () => ({
  GmailClient: class {
    constructor(public userId: string) {}
    listThreadIds(...args: unknown[]) {
      return clientList(...args);
    }
    getThreadMetadata(...args: unknown[]) {
      return clientGet(...args);
    }
  },
}));

async function loadRoute() {
  vi.resetModules();
  return await import('./route');
}

function makeRequest(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/gmail/fetch-threads', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  });
}

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    subject: 'subj',
    latestSnippet: 'snip',
    latestSender: 'a@b.com',
    latestSenderDomain: 'b.com',
    latestDate: '2026-04-28T16:00:00.000Z',
    isUnread: false,
    hasAttachments: false,
    messageCount: 1,
    labelIds: ['INBOX'],
    ...overrides,
  };
}

beforeEach(() => {
  supabaseAuth.getUser.mockReset();
  supabaseUpsert.mockReset();
  supabaseFrom.mockClear();
  classificationsEq.mockReset();
  // Default: no persisted classifications. Tests that exercise rehydration
  // override with mockResolvedValueOnce.
  classificationsEq.mockResolvedValue({ data: [], error: null });
  limiterLimit.mockReset();
  clientList.mockReset();
  clientGet.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/gmail/fetch-threads', () => {
  it('returns 401 when there is no Supabase user', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: null } });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('AUTH_ERROR');
    expect(limiterLimit).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when rate-limited', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    const json = await res.json();
    expect(json.error.code).toBe('RATE_LIMIT');
    expect(clientList).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid body', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest({ maxResults: 'lots' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(clientList).not.toHaveBeenCalled();
  });

  it('happy path: fetches and upserts 3 threads', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    clientList.mockResolvedValueOnce(['t1', 't2', 't3']);
    clientGet
      .mockResolvedValueOnce(thread('t1'))
      .mockResolvedValueOnce(thread('t2'))
      .mockResolvedValueOnce(thread('t3'));
    supabaseUpsert.mockResolvedValueOnce({ error: null });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(3);
    expect(json.fetched).toBe(3);
    expect(json.threads.map((t: { id: string }) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(json.failed).toEqual([]);

    expect(supabaseFrom).toHaveBeenCalledWith('threads');
    expect(supabaseUpsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = supabaseUpsert.mock.calls[0] as [
      Array<{ user_id: string; gmail_thread_id: string }>,
      { onConflict: string },
    ];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      user_id: 'u1',
      gmail_thread_id: 't1',
      sender_domain: 'b.com',
      message_count: 1,
    });
    // Crucially: the row shape carries no subject/snippet — only opaque fields.
    expect(rows[0]).not.toHaveProperty('subject');
    expect(rows[0]).not.toHaveProperty('latestSnippet');
    expect(opts.onConflict).toBe('user_id,gmail_thread_id');
  });

  it('isolates per-thread failures: 1 of 3 threads errors, request still succeeds', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    clientList.mockResolvedValueOnce(['t1', 't2', 't3']);
    clientGet
      .mockResolvedValueOnce(thread('t1'))
      .mockRejectedValueOnce(
        Object.assign(new Error('boom'), { code: 'EXTERNAL_API_ERROR', statusCode: 502 }),
      )
      .mockResolvedValueOnce(thread('t3'));
    supabaseUpsert.mockResolvedValueOnce({ error: null });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(3);
    expect(json.fetched).toBe(2);
    expect(json.failed).toEqual(['t2']);
    expect(json.threads.map((t: { id: string }) => t.id)).toEqual(['t1', 't3']);

    const [rows] = supabaseUpsert.mock.calls[0] as [Array<{ gmail_thread_id: string }>, unknown];
    expect(rows.map((r) => r.gmail_thread_id)).toEqual(['t1', 't3']);
  });

  it('returns 502 when listThreadIds fails', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { POST } = await loadRoute();
    // Import AFTER loadRoute so the AppError class instance matches the one
    // the freshly-loaded route handler will see — vi.resetModules() inside
    // loadRoute would otherwise leave us with a pre-reset class instance that
    // fails the route's `isAppError` check.
    const { ExternalApiError } = await import('@/lib/errors');
    clientList.mockRejectedValueOnce(new ExternalApiError('gmail', 'list failed'));

    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
    expect(supabaseUpsert).not.toHaveBeenCalled();
  });

  it('upserts with onConflict so re-running does not duplicate rows', async () => {
    supabaseAuth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    clientList.mockResolvedValue(['t1']);
    clientGet.mockResolvedValue(thread('t1'));
    supabaseUpsert.mockResolvedValue({ error: null });
    const { POST } = await loadRoute();

    await POST(makeRequest());
    await POST(makeRequest());

    expect(supabaseUpsert).toHaveBeenCalledTimes(2);
    for (const call of supabaseUpsert.mock.calls) {
      const opts = call[1] as { onConflict: string };
      expect(opts.onConflict).toBe('user_id,gmail_thread_id');
    }
  });

  it('returns 200 with empty arrays when the inbox has no threads', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    clientList.mockResolvedValueOnce([]);
    const { POST } = await loadRoute();

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ count: 0, fetched: 0, threads: [], failed: [] });
    expect(supabaseUpsert).not.toHaveBeenCalled();
  });
});
