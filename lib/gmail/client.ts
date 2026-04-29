import 'server-only';
import { google, type gmail_v1 } from 'googleapis';
import pLimit from 'p-limit';
import { ExternalApiError, OAuthRevokedError, isAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { GmailThread } from '@/types/thread';
import { getAccessToken } from './tokenManager';
import { parseThread } from './parser';

const RETRY_DELAYS_MS = [1000, 2000, 4000];

// Module-level limiter so two GmailClient instances in the same process
// (e.g. a fetch-threads route and a parallel draft route) share the budget.
const gmailLimit = pLimit(5);

export class GmailClient {
  constructor(private readonly userId: string) {}

  async listThreadIds(maxResults = 200): Promise<string[]> {
    const gmail = await this.newGmail();
    const res = await this.callGmail('threads.list', () =>
      gmail.users.threads.list({ userId: 'me', maxResults }),
    );
    const ids: string[] = [];
    for (const t of res.data.threads ?? []) {
      if (t.id) ids.push(t.id);
    }
    return ids;
  }

  async getThreadMetadata(threadId: string): Promise<GmailThread> {
    const gmail = await this.newGmail();
    const res = await this.callGmail('threads.get', () =>
      gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata' }),
    );
    return parseThread(res.data);
  }

  async archiveThread(threadId: string): Promise<void> {
    const gmail = await this.newGmail();
    await this.callGmail('threads.archive', () =>
      gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: { removeLabelIds: ['INBOX'] },
      }),
    );
  }

  async addLabel(threadId: string, labelName: string): Promise<void> {
    const gmail = await this.newGmail();
    const labelId = await this.resolveLabelId(gmail, labelName);
    await this.callGmail('threads.label', () =>
      gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: { addLabelIds: [labelId] },
      }),
    );
  }

  async createDraft(threadId: string, body: string): Promise<{ draftId: string }> {
    const gmail = await this.newGmail();
    const raw = encodeRfc822(body);
    const res = await this.callGmail('drafts.create', () =>
      gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { threadId, raw } },
      }),
    );
    if (!res.data.id) {
      throw new ExternalApiError('gmail', 'drafts.create returned no id');
    }
    return { draftId: res.data.id };
  }

  private async newGmail(): Promise<gmail_v1.Gmail> {
    const accessToken = await getAccessToken(this.userId);
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth });
  }

  private async resolveLabelId(gmail: gmail_v1.Gmail, name: string): Promise<string> {
    const list = await this.callGmail('labels.list', () =>
      gmail.users.labels.list({ userId: 'me' }),
    );
    const existing = list.data.labels?.find((l) => l.name === name);
    if (existing?.id) return existing.id;

    try {
      const created = await this.callGmail('labels.create', () =>
        gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          },
        }),
      );
      if (!created.data.id) {
        throw new ExternalApiError('gmail', 'labels.create returned no id');
      }
      return created.data.id;
    } catch (err) {
      // Race: another caller created the label between our list and create.
      // Re-list and use the now-existing id.
      if (isAppError(err) && extractStatus(err.cause) === 409) {
        const relist = await this.callGmail('labels.list.recover', () =>
          gmail.users.labels.list({ userId: 'me' }),
        );
        const found = relist.data.labels?.find((l) => l.name === name);
        if (found?.id) return found.id;
      }
      throw err;
    }
  }

  private callGmail<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    return gmailLimit(() => withRetry(opName, this.userId, fn));
  }
}

async function withRetry<T>(opName: string, userId: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await fn();
      logger.info(`gmail.${opName}.success`, {
        userId,
        attempt,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      lastErr = err;
      const status = extractStatus(err);
      const retryable = status === 429 || (status !== undefined && status >= 500 && status < 600);
      if (!retryable || attempt === 3) {
        const wrapped = classifyError(opName, err);
        logger.error(`gmail.${opName}.failed`, {
          userId,
          attempt,
          statusCode: status,
          errorCode: isAppError(wrapped) ? wrapped.code : 'UNKNOWN',
        });
        throw wrapped;
      }
      logger.warn(`gmail.${opName}.retry`, {
        userId,
        attempt,
        statusCode: status,
      });
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  // Unreachable — the loop either returns or throws on attempt 3.
  throw classifyError(opName, lastErr);
}

export function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as {
    status?: number;
    response?: { status?: number };
    code?: string | number;
  };
  if (typeof e.response?.status === 'number') return e.response.status;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.code === 'string' && /^\d+$/.test(e.code)) {
    return parseInt(e.code, 10);
  }
  return undefined;
}

function classifyError(opName: string, err: unknown): Error {
  if (err instanceof OAuthRevokedError) return err;
  if (
    isAppError(err) &&
    (err.code === 'OAUTH_TOKEN_MISSING' || err.code === 'GMAIL_TOKEN_REFRESH_FAILED')
  ) {
    return err;
  }
  return new ExternalApiError('gmail', `${opName} failed`, err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeRfc822(body: string): string {
  const lines = ['Content-Type: text/plain; charset=utf-8', 'MIME-Version: 1.0', '', body];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
