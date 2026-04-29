import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const supabaseAuth = { getUser: vi.fn<() => Promise<unknown>>() };
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: supabaseAuth,
    from: vi.fn(),
  })),
}));

const limiterLimit = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/ratelimit', () => ({
  gmailMutationLimiter: { limit: (...args: unknown[]) => limiterLimit(...args) },
}));

const addLabel = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/gmail/client', () => ({
  GmailClient: class {
    constructor(public userId: string) {}
    addLabel(...args: unknown[]) {
      return addLabel(...args);
    }
  },
}));

async function loadRoute() {
  vi.resetModules();
  return await import('./route');
}

function makeRequest(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/gmail/label', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  });
}

beforeEach(() => {
  supabaseAuth.getUser.mockReset();
  limiterLimit.mockReset();
  addLabel.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/gmail/label', () => {
  it('returns 401 when not signed in', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: null } });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadIds: ['t1'], labelName: 'X' }));
    expect(res.status).toBe(401);
    expect(addLabel).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadIds: ['t1'], labelName: 'X' }));
    expect(res.status).toBe(429);
    expect(addLabel).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing labelName', body: { threadIds: ['t1'] } },
    { name: 'empty labelName', body: { threadIds: ['t1'], labelName: '' } },
    { name: 'empty threadIds', body: { threadIds: [], labelName: 'X' } },
    {
      name: 'over 50 threadIds',
      body: { threadIds: Array.from({ length: 51 }, (_, i) => `t${i}`), labelName: 'X' },
    },
  ])('returns 400 on invalid body ($name)', async ({ body }) => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(400);
    expect(addLabel).not.toHaveBeenCalled();
  });

  it('happy path: labels 3 threads with the same label', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    addLabel
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadIds: ['t1', 't2', 't3'], labelName: 'Newsletter' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ labeled: ['t1', 't2', 't3'], failed: [] });
    for (const call of addLabel.mock.calls) {
      expect(call[1]).toBe('Newsletter');
    }
  });

  it('isolates per-thread failures', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    addLabel
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EXTERNAL_API_ERROR' }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadIds: ['t1', 't2'], labelName: 'X' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.labeled).toEqual(['t1']);
    expect(json.failed).toEqual(['t2']);
  });

  it('passes-through GmailClient lazy-create-label race recovery (route blind to it)', async () => {
    // The 409 race is owned by GmailClient.resolveLabelId — by the time the
    // route sees the result, addLabel has already resolved successfully.
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    addLabel.mockResolvedValueOnce(undefined);
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadIds: ['t1'], labelName: 'New' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.labeled).toEqual(['t1']);
  });
});
