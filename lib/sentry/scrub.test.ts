import type { ErrorEvent } from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';
import { beforeSend } from './scrub';

function baseEvent(partial: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    event_id: 'evt_1',
    timestamp: 1700000000,
    platform: 'node',
    ...partial,
  } as ErrorEvent;
}

describe('beforeSend', () => {
  it('keeps only allowlisted keys in event.extra', () => {
    const out = beforeSend(
      baseEvent({
        extra: {
          threadId: 't_1',
          userId: 'u_1',
          bucket: 'important',
          confidence: 0.9,
          requestId: 'req_1',
          subject: 'Q4 board meeting',
          body: 'secret content',
          snippet: 'Hi team...',
          sender: 'ceo@company.com',
          senderEmail: 'ceo@company.com',
          email: 'leak@example.com',
          messageBody: 'leak',
          password: 'hunter2',
          token: 'sk-secret',
        },
      }),
    );

    expect(out.extra).toEqual({
      threadId: 't_1',
      userId: 'u_1',
      bucket: 'important',
      confidence: 0.9,
      requestId: 'req_1',
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('ceo@company.com');
    expect(serialized).not.toContain('Q4 board meeting');
    expect(serialized).not.toContain('secret');
  });

  it('drops nested objects on allowlisted keys (forces flat structure)', () => {
    const out = beforeSend(
      baseEvent({
        extra: {
          threadId: 't_1',
          bucket: { name: 'leak' },
          action: ['archive', 'label'],
        },
      }),
    );

    expect(out.extra).toEqual({ threadId: 't_1' });
  });

  it('filters event.tags with the same allowlist', () => {
    const out = beforeSend(
      baseEvent({
        tags: {
          userId: 'u_1',
          bucket: 'newsletter',
          email: 'leak@example.com',
          subject: 'leak',
        },
      }),
    );

    expect(out.tags).toEqual({ userId: 'u_1', bucket: 'newsletter' });
  });

  it('filters event.breadcrumbs[].data', () => {
    const out = beforeSend(
      baseEvent({
        breadcrumbs: [
          {
            type: 'http',
            category: 'fetch',
            data: {
              requestId: 'req_1',
              statusCode: 200,
              subject: 'Q4 board meeting',
              body: 'leak',
            },
          },
          {
            type: 'log',
            data: {
              email: 'leak@example.com',
              userId: 'u_1',
            },
          },
        ],
      }),
    );

    expect(out.breadcrumbs?.[0].data).toEqual({ requestId: 'req_1', statusCode: 200 });
    expect(out.breadcrumbs?.[1].data).toEqual({ userId: 'u_1' });
    expect(JSON.stringify(out)).not.toContain('Q4 board meeting');
    expect(JSON.stringify(out)).not.toContain('leak@example.com');
  });

  it('reduces event.user to { id } only', () => {
    const out = beforeSend(
      baseEvent({
        user: {
          id: 'u_1',
          email: 'user@example.com',
          username: 'jane',
          ip_address: '203.0.113.1',
        },
      }),
    );

    expect(out.user).toEqual({ id: 'u_1' });
    expect(JSON.stringify(out)).not.toContain('user@example.com');
    expect(JSON.stringify(out)).not.toContain('203.0.113.1');
  });

  it('drops event.request.data, cookies, headers, query_string', () => {
    const out = beforeSend(
      baseEvent({
        request: {
          url: 'https://example.com/api/classify',
          method: 'POST',
          data: { subject: 'leak', body: 'leak' },
          cookies: { 'sb-access-token': 'leak' },
          headers: { authorization: 'Bearer leak', cookie: 'leak' },
          query_string: 'q=leak@example.com',
        },
      }),
    );

    expect(out.request?.url).toBe('https://example.com/api/classify');
    expect(out.request?.method).toBe('POST');
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
  });

  it('preserves Sentry built-in contexts and drops custom ones', () => {
    const out = beforeSend(
      baseEvent({
        contexts: {
          runtime: { name: 'node', version: '20.10.0' },
          os: { name: 'linux' },
          browser: { name: 'chrome' },
          customLeak: { subject: 'leak', body: 'leak' },
        },
      }),
    );

    expect(out.contexts?.runtime).toEqual({ name: 'node', version: '20.10.0' });
    expect(out.contexts?.os).toEqual({ name: 'linux' });
    expect(out.contexts?.browser).toEqual({ name: 'chrome' });
    expect(out.contexts?.customLeak).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('leak');
  });

  it('preserves event.message (controlled by AppError)', () => {
    const out = beforeSend(baseEvent({ message: 'AUTH_ERROR: Invalid token' }));
    expect(out.message).toBe('AUTH_ERROR: Invalid token');
  });

  it('preserves event.exception.values[].value', () => {
    const out = beforeSend(
      baseEvent({
        exception: {
          values: [{ type: 'ExternalApiError', value: 'Gmail: 429 rate limit exceeded' }],
        },
      }),
    );
    expect(out.exception?.values?.[0].value).toBe('Gmail: 429 rate limit exceeded');
  });

  it('returns the event (never null)', () => {
    const event = baseEvent({ extra: { threadId: 't_1' } });
    expect(beforeSend(event)).not.toBeNull();
  });

  it('defense check: synthetic email-laden event has zero leaks', () => {
    const out = beforeSend(
      baseEvent({
        extra: {
          subject: 'CONFIDENTIAL: merger talks',
          body: 'attached financials show...',
          snippet: 'Per our discussion',
          sender: 'cfo@company.com',
          email: 'leak@example.com',
        },
        tags: { senderEmail: 'leak@example.com' },
        user: { id: 'u_1', email: 'user@example.com' },
        request: {
          data: { subject: 'leak' },
          cookies: { token: 'leak' },
          headers: { authorization: 'Bearer leak' },
          query_string: 'q=user@example.com',
        },
        breadcrumbs: [{ data: { body: 'leak', email: 'leak@example.com' } }],
        contexts: { customLeak: { subject: 'leak' } },
      }),
    );

    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/CONFIDENTIAL/);
    expect(serialized).not.toMatch(/merger talks/);
    expect(serialized).not.toMatch(/attached financials/);
    expect(serialized).not.toMatch(/Per our discussion/);
    expect(serialized).not.toMatch(/cfo@company\.com/);
    expect(serialized).not.toMatch(/user@example\.com/);
    expect(serialized).not.toMatch(/leak@example\.com/);
    expect(serialized).not.toMatch(/Bearer leak/);
  });
});
