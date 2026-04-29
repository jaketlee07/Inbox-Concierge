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

const createDraft = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/gmail/client', () => ({
  GmailClient: class {
    constructor(public userId: string) {}
    createDraft(...args: unknown[]) {
      return createDraft(...args);
    }
  },
}));

async function loadRoute() {
  vi.resetModules();
  return await import('./route');
}

function makeRequest(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/gmail/draft', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  });
}

beforeEach(() => {
  supabaseAuth.getUser.mockReset();
  limiterLimit.mockReset();
  createDraft.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/gmail/draft', () => {
  it('returns 401 when not signed in', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: null } });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadId: 't1', body: 'hi' }));
    expect(res.status).toBe(401);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ threadId: 't1', body: 'hi' }));
    expect(res.status).toBe(429);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing threadId', body: { body: 'hi' } },
    { name: 'missing body', body: { threadId: 't1' } },
    { name: 'empty body', body: { threadId: 't1', body: '' } },
    { name: 'oversized body', body: { threadId: 't1', body: 'x'.repeat(10_001) } },
  ])('returns 400 on invalid body ($name)', async ({ body }) => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(400);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('happy path: returns the draft id', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    createDraft.mockResolvedValueOnce({ draftId: 'd_abc' });
    const { POST } = await loadRoute();

    const res = await POST(makeRequest({ threadId: 't1', body: 'Thanks, will follow up.' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ draftId: 'd_abc' });
    expect(createDraft).toHaveBeenCalledWith('t1', 'Thanks, will follow up.');
  });

  it('surfaces Gmail failures via toErrorResponse', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { POST } = await loadRoute();
    const { ExternalApiError } = await import('@/lib/errors');
    createDraft.mockRejectedValueOnce(new ExternalApiError('gmail', 'create failed'));

    const res = await POST(makeRequest({ threadId: 't1', body: 'hi' }));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe('EXTERNAL_API_ERROR');
  });
});
