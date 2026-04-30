import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared before any import of the unit-under-test, and we
// re-import the module per test (`vi.resetModules()`) so the module-level
// pLimit(5) is fresh — otherwise concurrency state leaks between cases.

vi.mock('@/lib/env', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    DB_ENCRYPTION_KEY: 'a'.repeat(32),
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost',
    SUPABASE_SERVICE_ROLE_KEY: 'sr',
  },
}));

const tokenMock = { getAccessToken: vi.fn(async () => 'fake-access-token') };
vi.mock('@/lib/gmail/tokenManager', () => tokenMock);

type MockFn = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
const mocks: {
  threadsList: MockFn;
  threadsGet: MockFn;
  threadsModify: MockFn;
  labelsList: MockFn;
  labelsCreate: MockFn;
  draftsCreate: MockFn;
} = {
  threadsList: vi.fn(),
  threadsGet: vi.fn(),
  threadsModify: vi.fn(),
  labelsList: vi.fn(),
  labelsCreate: vi.fn(),
  draftsCreate: vi.fn(),
};

class FakeOAuth2 {
  setCredentials() {}
}

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: FakeOAuth2 },
    gmail: vi.fn(() => ({
      users: {
        threads: {
          list: (...args: unknown[]) => mocks.threadsList(...args),
          get: (...args: unknown[]) => mocks.threadsGet(...args),
          modify: (...args: unknown[]) => mocks.threadsModify(...args),
        },
        labels: {
          list: (...args: unknown[]) => mocks.labelsList(...args),
          create: (...args: unknown[]) => mocks.labelsCreate(...args),
        },
        drafts: {
          create: (...args: unknown[]) => mocks.draftsCreate(...args),
        },
      },
    })),
  },
}));

async function loadClient() {
  vi.resetModules();
  const mod = await import('./client');
  return mod;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(mocks).forEach((m) => m.mockReset());
  tokenMock.getAccessToken.mockReset();
  tokenMock.getAccessToken.mockResolvedValue('fake-access-token');
});

afterEach(() => {
  vi.useRealTimers();
});

function gaxiosErr(status: number) {
  return Object.assign(new Error(`http ${status}`), { response: { status } });
}

describe('GmailClient.listThreadIds', () => {
  it('returns ids on first try', async () => {
    mocks.threadsList.mockResolvedValueOnce({
      data: { threads: [{ id: 't1' }, { id: 't2' }, {}] },
    });
    const { GmailClient } = await loadClient();

    const ids = await new GmailClient('u1').listThreadIds();
    expect(ids).toEqual(['t1', 't2']);
    expect(mocks.threadsList).toHaveBeenCalledTimes(1);
    expect(mocks.threadsList.mock.calls[0][0]).toEqual({ userId: 'me', maxResults: 200 });
  });

  it('passes a custom maxResults', async () => {
    mocks.threadsList.mockResolvedValueOnce({ data: { threads: [] } });
    const { GmailClient } = await loadClient();

    await new GmailClient('u1').listThreadIds(25);
    expect(mocks.threadsList.mock.calls[0][0]).toEqual({ userId: 'me', maxResults: 25 });
  });
});

describe('GmailClient retry logic', () => {
  it('retries on 429 then succeeds', async () => {
    mocks.threadsList
      .mockRejectedValueOnce(gaxiosErr(429))
      .mockResolvedValueOnce({ data: { threads: [{ id: 't1' }] } });
    const { GmailClient } = await loadClient();

    const promise = new GmailClient('u1').listThreadIds();
    await vi.advanceTimersByTimeAsync(1000);
    const ids = await promise;

    expect(ids).toEqual(['t1']);
    expect(mocks.threadsList).toHaveBeenCalledTimes(2);
  });

  it.each([500, 502, 503])('retries on %i then succeeds', async (status) => {
    mocks.threadsList
      .mockRejectedValueOnce(gaxiosErr(status))
      .mockResolvedValueOnce({ data: { threads: [] } });
    const { GmailClient } = await loadClient();

    const promise = new GmailClient('u1').listThreadIds();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(mocks.threadsList).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 401', async () => {
    mocks.threadsList.mockRejectedValueOnce(gaxiosErr(401));
    const { GmailClient } = await loadClient();

    await expect(new GmailClient('u1').listThreadIds()).rejects.toMatchObject({
      code: 'EXTERNAL_API_ERROR',
    });
    expect(mocks.threadsList).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 404', async () => {
    mocks.threadsList.mockRejectedValueOnce(gaxiosErr(404));
    const { GmailClient } = await loadClient();

    await expect(new GmailClient('u1').listThreadIds()).rejects.toMatchObject({
      code: 'EXTERNAL_API_ERROR',
    });
    expect(mocks.threadsList).toHaveBeenCalledTimes(1);
  });

  it('exhausts after 3 attempts on persistent 500', async () => {
    mocks.threadsList
      .mockRejectedValueOnce(gaxiosErr(500))
      .mockRejectedValueOnce(gaxiosErr(500))
      .mockRejectedValueOnce(gaxiosErr(500));
    const { GmailClient } = await loadClient();

    const promise = new GmailClient('u1').listThreadIds();
    // Catch eagerly so the rejection isn't unhandled while we advance timers.
    const settled = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(3000);

    const result = await settled;
    expect(result).toMatchObject({ code: 'EXTERNAL_API_ERROR' });
    expect(mocks.threadsList).toHaveBeenCalledTimes(3);
  });

  it('propagates OAuthRevokedError without wrapping', async () => {
    const { OAuthRevokedError } = await import('@/lib/errors');
    tokenMock.getAccessToken.mockRejectedValueOnce(new OAuthRevokedError());
    const { GmailClient } = await loadClient();

    await expect(new GmailClient('u1').listThreadIds()).rejects.toBeInstanceOf(OAuthRevokedError);
    expect(mocks.threadsList).not.toHaveBeenCalled();
  });
});

describe('GmailClient.getThreadMetadata', () => {
  it('uses format=metadata and parses the response', async () => {
    mocks.threadsGet.mockResolvedValueOnce({
      data: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            internalDate: '1745683200000',
            labelIds: ['INBOX'],
            snippet: 'hi',
            payload: {
              headers: [
                { name: 'Subject', value: 'Hello' },
                { name: 'From', value: 'a@b.com' },
              ],
            },
          },
        ],
      },
    });
    const { GmailClient } = await loadClient();

    const result = await new GmailClient('u1').getThreadMetadata('t1');
    expect(result.id).toBe('t1');
    expect(result.subject).toBe('Hello');
    expect(result.latestSenderDomain).toBe('b.com');
    expect(mocks.threadsGet.mock.calls[0][0]).toMatchObject({
      userId: 'me',
      id: 't1',
      format: 'metadata',
    });
  });
});

describe('GmailClient.archiveThread', () => {
  it('removes INBOX label', async () => {
    mocks.threadsModify.mockResolvedValueOnce({ data: {} });
    const { GmailClient } = await loadClient();

    await new GmailClient('u1').archiveThread('t1');
    expect(mocks.threadsModify.mock.calls[0][0]).toEqual({
      userId: 'me',
      id: 't1',
      requestBody: { removeLabelIds: ['INBOX'] },
    });
  });
});

describe('GmailClient.addLabel', () => {
  it('uses an existing label without creating', async () => {
    mocks.labelsList.mockResolvedValueOnce({
      data: { labels: [{ id: 'L1', name: 'Newsletter' }] },
    });
    mocks.threadsModify.mockResolvedValueOnce({ data: {} });
    const { GmailClient } = await loadClient();

    await new GmailClient('u1').addLabel('t1', 'Newsletter');
    expect(mocks.labelsCreate).not.toHaveBeenCalled();
    expect(mocks.threadsModify.mock.calls[0][0]).toMatchObject({
      requestBody: { addLabelIds: ['L1'] },
    });
  });

  it('creates the label when missing', async () => {
    mocks.labelsList.mockResolvedValueOnce({ data: { labels: [] } });
    mocks.labelsCreate.mockResolvedValueOnce({ data: { id: 'L2', name: 'Custom' } });
    mocks.threadsModify.mockResolvedValueOnce({ data: {} });
    const { GmailClient } = await loadClient();

    await new GmailClient('u1').addLabel('t1', 'Custom');
    expect(mocks.labelsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.threadsModify.mock.calls[0][0]).toMatchObject({
      requestBody: { addLabelIds: ['L2'] },
    });
  });

  it('reuses a system label via case-insensitive match (Important → IMPORTANT)', async () => {
    mocks.labelsList.mockResolvedValueOnce({
      data: { labels: [{ id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' }] },
    });
    mocks.threadsModify.mockResolvedValueOnce({ data: {} });
    const { GmailClient } = await loadClient();

    await new GmailClient('u1').addLabel('t1', 'Important');
    expect(mocks.labelsCreate).not.toHaveBeenCalled();
    expect(mocks.threadsModify.mock.calls[0][0]).toMatchObject({
      requestBody: { addLabelIds: ['IMPORTANT'] },
    });
  });

  it('does not case-insensitive-match user labels (only system labels)', async () => {
    // A user-created label "important" (lowercase) must NOT shadow the
    // intent to use Gmail's IMPORTANT system label or to create "Important".
    mocks.labelsList.mockResolvedValueOnce({
      data: { labels: [{ id: 'L_user', name: 'important', type: 'user' }] },
    });
    mocks.labelsCreate.mockResolvedValueOnce({
      data: { id: 'L_new', name: 'Important' },
    });
    mocks.threadsModify.mockResolvedValueOnce({ data: {} });
    const { GmailClient } = await loadClient();

    await new GmailClient('u1').addLabel('t1', 'Important');
    expect(mocks.labelsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.threadsModify.mock.calls[0][0]).toMatchObject({
      requestBody: { addLabelIds: ['L_new'] },
    });
  });

  it('recovers from a 409 race by re-listing labels', async () => {
    mocks.labelsList
      .mockResolvedValueOnce({ data: { labels: [] } })
      .mockResolvedValueOnce({ data: { labels: [{ id: 'L3', name: 'Custom' }] } });
    mocks.labelsCreate.mockRejectedValueOnce(gaxiosErr(409));
    mocks.threadsModify.mockResolvedValueOnce({ data: {} });
    const { GmailClient } = await loadClient();

    await new GmailClient('u1').addLabel('t1', 'Custom');
    expect(mocks.labelsList).toHaveBeenCalledTimes(2);
    expect(mocks.threadsModify.mock.calls[0][0]).toMatchObject({
      requestBody: { addLabelIds: ['L3'] },
    });
  });
});

describe('GmailClient.createDraft', () => {
  it('passes threadId and base64url-encoded RFC 822 raw', async () => {
    mocks.draftsCreate.mockResolvedValueOnce({ data: { id: 'd1' } });
    const { GmailClient } = await loadClient();

    const result = await new GmailClient('u1').createDraft('t1', 'Hello there');
    expect(result.draftId).toBe('d1');

    const req = mocks.draftsCreate.mock.calls[0][0] as {
      requestBody: { message: { threadId: string; raw: string } };
    };
    expect(req.requestBody.message.threadId).toBe('t1');
    const decoded = Buffer.from(req.requestBody.message.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('Content-Type: text/plain; charset=utf-8');
    expect(decoded).toContain('MIME-Version: 1.0');
    expect(decoded).toContain('Hello there');
  });
});

describe('GmailClient concurrency', () => {
  it('caps in-flight calls at 5', async () => {
    let inFlight = 0;
    let peak = 0;
    const deferreds: Array<() => void> = [];

    mocks.threadsList.mockImplementation(() => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        deferreds.push(() => {
          inFlight--;
          resolve({ data: { threads: [] } });
        });
      });
    });

    const { GmailClient } = await loadClient();
    const client = new GmailClient('u1');

    const calls = Array.from({ length: 10 }, () => client.listThreadIds());
    // Drain microtasks so all 10 reach the limiter; only 5 should have started.
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(5);

    // Resolve the in-flight five; the limiter should release the next 5.
    for (let i = 0; i < 5; i++) deferreds[i]();
    await vi.advanceTimersByTimeAsync(0);
    expect(deferreds.length).toBe(10);

    for (let i = 5; i < 10; i++) deferreds[i]();
    await Promise.all(calls);
    expect(peak).toBe(5);
  });

  it('limiter is not poisoned by a rejected call', async () => {
    mocks.threadsList
      .mockRejectedValueOnce(gaxiosErr(401))
      .mockResolvedValueOnce({ data: { threads: [{ id: 't1' }] } });
    const { GmailClient } = await loadClient();
    const client = new GmailClient('u1');

    await expect(client.listThreadIds()).rejects.toMatchObject({
      code: 'EXTERNAL_API_ERROR',
    });
    const ids = await client.listThreadIds();
    expect(ids).toEqual(['t1']);
  });
});
