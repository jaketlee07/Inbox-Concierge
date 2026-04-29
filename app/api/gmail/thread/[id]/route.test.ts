import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const supabaseAuth = { getUser: vi.fn<() => Promise<unknown>>() };
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: supabaseAuth, from: vi.fn() })),
}));

const limiterLimit = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/ratelimit', () => ({
  gmailThreadReadLimiter: { limit: (...args: unknown[]) => limiterLimit(...args) },
}));

const getThreadMetadata = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/gmail/client', () => ({
  GmailClient: class {
    constructor(public userId: string) {}
    getThreadMetadata(...args: unknown[]) {
      return getThreadMetadata(...args);
    }
  },
}));

async function loadRoute() {
  vi.resetModules();
  return await import('./route');
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/gmail/thread/abc', {
    method: 'GET',
    headers: { 'x-request-id': 'req-1' },
  });
}

const ctx = { params: Promise.resolve({ id: 'abc' }) };

beforeEach(() => {
  supabaseAuth.getUser.mockReset();
  limiterLimit.mockReset();
  getThreadMetadata.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/gmail/thread/[id]', () => {
  it('returns 401 when not signed in', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: null } });
    const { GET } = await loadRoute();
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(401);
    expect(getThreadMetadata).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });
    const { GET } = await loadRoute();
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(429);
    expect(getThreadMetadata).not.toHaveBeenCalled();
  });

  it('returns 400 when id param is empty', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { GET } = await loadRoute();
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: '' }) });
    expect(res.status).toBe(400);
    expect(getThreadMetadata).not.toHaveBeenCalled();
  });

  it('happy path: returns the parsed thread', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const thread = {
      id: 'abc',
      subject: 'hi',
      latestSnippet: 's',
      latestSender: 'a@b.com',
      latestSenderDomain: 'b.com',
      latestDate: '2026-04-29T00:00:00.000Z',
      isUnread: true,
      hasAttachments: false,
      messageCount: 1,
      labelIds: ['INBOX', 'UNREAD'],
    };
    getThreadMetadata.mockResolvedValueOnce(thread);
    const { GET } = await loadRoute();

    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(thread);
    expect(getThreadMetadata).toHaveBeenCalledWith('abc');
  });

  it('surfaces upstream Gmail failures via toErrorResponse', async () => {
    supabaseAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } });
    limiterLimit.mockResolvedValueOnce({ success: true, reset: Date.now() + 60_000 });
    const { GET } = await loadRoute();
    const { ExternalApiError } = await import('@/lib/errors');
    getThreadMetadata.mockRejectedValueOnce(new ExternalApiError('gmail', 'not found'));

    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe('EXTERNAL_API_ERROR');
  });
});
