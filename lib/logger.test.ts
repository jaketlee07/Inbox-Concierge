import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { AuthError } from './errors';
import { logger } from './logger';

describe('logger', () => {
  let logSpy: MockInstance<typeof console.log>;
  let warnSpy: MockInstance<typeof console.warn>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastJson(spy: MockInstance<(...args: unknown[]) => void>): Record<string, unknown> {
    const calls = spy.mock.calls;
    const lastCall = calls[calls.length - 1];
    return JSON.parse(lastCall[0] as string) as Record<string, unknown>;
  }

  it('emits allowed fields verbatim', () => {
    logger.info('classify.completed', {
      threadId: 't_123',
      userId: 'u_456',
      bucket: 'important',
      confidence: 0.92,
      action: 'archive',
      requestId: 'req_xyz',
      durationMs: 145,
    });

    const out = lastJson(logSpy);
    expect(out.threadId).toBe('t_123');
    expect(out.userId).toBe('u_456');
    expect(out.bucket).toBe('important');
    expect(out.confidence).toBe(0.92);
    expect(out.action).toBe('archive');
    expect(out.requestId).toBe('req_xyz');
    expect(out.durationMs).toBe(145);
    expect(out.event).toBe('classify.completed');
  });

  it('emits retry control-plane fields', () => {
    logger.warn('gmail.retry', {
      userId: 'u_1',
      attempt: 2,
      statusCode: 429,
      errorCode: 'EXTERNAL_API_ERROR',
    });

    const out = lastJson(warnSpy);
    expect(out.attempt).toBe(2);
    expect(out.statusCode).toBe(429);
    expect(out.errorCode).toBe('EXTERNAL_API_ERROR');
  });

  it('strips sensitive/disallowed fields', () => {
    logger.info('email.classified', {
      threadId: 't_123',
      subject: 'Q4 board meeting',
      body: 'lots of secret content',
      snippet: 'Hi team...',
      sender: 'ceo@company.com',
      senderEmail: 'ceo@company.com',
      reasoning: 'Claude said this is important because...',
      password: 'hunter2',
      token: 'sk-ant-secret',
      apiKey: 'secret-key',
    });

    const out = lastJson(logSpy);
    expect(out.threadId).toBe('t_123');
    expect(out).not.toHaveProperty('subject');
    expect(out).not.toHaveProperty('body');
    expect(out).not.toHaveProperty('snippet');
    expect(out).not.toHaveProperty('sender');
    expect(out).not.toHaveProperty('senderEmail');
    expect(out).not.toHaveProperty('reasoning');
    expect(out).not.toHaveProperty('password');
    expect(out).not.toHaveProperty('token');
    expect(out).not.toHaveProperty('apiKey');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('ceo@company.com');
  });

  it('rejects nested objects on allowlisted keys (forces flat logs)', () => {
    logger.info('test.event', {
      threadId: 't_123',
      bucket: { name: 'leaked' },
      action: ['archive', 'label'],
    });

    const out = lastJson(logSpy);
    expect(out.threadId).toBe('t_123');
    expect(out).not.toHaveProperty('bucket');
    expect(out).not.toHaveProperty('action');
  });

  it('auto-injects level and timestamp', () => {
    logger.info('test.event', { threadId: 't_1' });

    const out = lastJson(logSpy);
    expect(out.level).toBe('info');
    expect(out.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('caller cannot override level via fields', () => {
    logger.info('test.event', { level: 'error', threadId: 't_1' });

    const out = lastJson(logSpy);
    expect(out.level).toBe('info');
  });

  it('warn writes to console.warn, not console.log', () => {
    logger.warn('rate.limit.near', { userId: 'u_1' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const out = lastJson(warnSpy);
    expect(out.level).toBe('warn');
    expect(out.event).toBe('rate.limit.near');
    expect(out.userId).toBe('u_1');
  });

  it('error includes statusCode when given an AppError', () => {
    logger.error('auth.failed', { requestId: 'r_1' }, new AuthError('bad token'));

    const out = lastJson(errorSpy);
    expect(out.event).toBe('auth.failed');
    expect(out.requestId).toBe('r_1');
    expect(out.statusCode).toBe(401);
    expect(out.level).toBe('error');
    expect(out).not.toHaveProperty('message');
  });

  it('error redacts raw Error message contents', () => {
    logger.error(
      'gmail.fetch.failed',
      { requestId: 'r_2' },
      new Error('database password=hunter2 for user@example.com'),
    );

    const out = lastJson(errorSpy);
    expect(out.event).toBe('gmail.fetch.failed');
    expect(out.requestId).toBe('r_2');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('database');
  });

  it('error works without an error argument', () => {
    logger.error('something.failed', { requestId: 'r_3' });

    const out = lastJson(errorSpy);
    expect(out.event).toBe('something.failed');
    expect(out.requestId).toBe('r_3');
    expect(out).not.toHaveProperty('statusCode');
  });
});
