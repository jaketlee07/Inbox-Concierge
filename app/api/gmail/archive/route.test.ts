import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const supabaseAuth = { getUser: vi.fn<() => Promise<unknown>>() };

// `from('threads').update({...}).eq(col, val).in(col, vals)` — capture every
// link of the chain so tests can assert on the final patch + filter.
const updateInResult = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const updateChain: { eq: ReturnType<typeof vi.fn>; in: (...a: unknown[]) => Promise<unknown> } = {
  eq: vi.fn(() => updateChain),
  in: (...args: unknown[]) => updateInResult(...args),
};
const fromUpdate = vi.fn(() => updateChain);
const supabaseFrom = vi.fn(() => ({ update: fromUpdate }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: supabaseAuth,
    from: supabaseFrom,
  })),
}));

const limiterLimit = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/ratelimit', () => ({
  gmailMutationLimiter: { limit: (...args: unknown[]) => limiterLimit(...args) },
}));

const archiveThread = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/gmail/client', () => ({
  GmailClient: class {
    constructor(public userId: string) {}
    archiveThread(...args: unknown[]) {
      return archiveThread(...args);
    }
  },
}));

async function loadRoute() {
  vi.resetModules();
  return await import('./route');
}

function makeRequest(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/gmail/archive', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  });
}

beforeEach(() => {
  supabaseAuth.getUser.mockReset();
  updateInResult.mockReset();
  updateChain.eq.mockClear();
  fromUpdate.mockClear();
  supabaseFrom.mockClear();
  limiterLimit.mockReset();
  archiveThread.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/gmail/archive', () => {
  it('returns 401 when not signed in', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: null } });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadIds: ['t1'] }));
    expect(res.status).toBe(401);
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadIds: ['t1'] }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'empty threadIds', body: { threadIds: [] } },
    { name: 'missing threadIds', body: {} },
    { name: 'non-string entry', body: { threadIds: [1] } },
    { name: 'over 50 entries', body: { threadIds: Array.from({ length: 51 }, (_, i) => `t${i}`) } },
  ])('returns 400 on invalid body ($name)', async ({ body }) => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(400);
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it('happy path: archives 3 threads and updates DB', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    archiveThread
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    updateInResult.mockResolvedValueOnce({ error: null });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest({ threadIds: ['t1', 't2', 't3'] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ archived: ['t1', 't2', 't3'], failed: [] });

    expect(archiveThread).toHaveBeenCalledTimes(3);
    expect(supabaseFrom).toHaveBeenCalledWith('threads');
    expect(fromUpdate).toHaveBeenCalledWith({ classification_status: 'executed' });
    expect(updateChain.eq).toHaveBeenCalledWith('user_id', 'u1');
    expect(updateInResult).toHaveBeenCalledWith('gmail_thread_id', ['t1', 't2', 't3']);
  });

  it('isolates a per-thread failure: DB update only includes successes', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    archiveThread
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EXTERNAL_API_ERROR' }))
      .mockResolvedValueOnce(undefined);
    updateInResult.mockResolvedValueOnce({ error: null });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest({ threadIds: ['t1', 't2', 't3'] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.archived).toEqual(['t1', 't3']);
    expect(json.failed).toEqual(['t2']);
    expect(updateInResult).toHaveBeenCalledWith('gmail_thread_id', ['t1', 't3']);
  });

  it('skips DB update entirely when every thread fails', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    archiveThread
      .mockRejectedValueOnce(new Error('boom1'))
      .mockRejectedValueOnce(new Error('boom2'));
    const { POST } = await loadRoute();

    const res = await POST(makeRequest({ threadIds: ['t1', 't2'] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.archived).toEqual([]);
    expect(json.failed).toEqual(['t1', 't2']);
    expect(fromUpdate).not.toHaveBeenCalled();
  });
});
