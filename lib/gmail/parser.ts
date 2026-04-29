import type { gmail_v1 } from 'googleapis';
import { AppError } from '@/lib/errors';
import type { GmailThread } from '@/types/thread';

// The CLAUDE.md spec gives `@([\w.-]+)$` for the From header. That regex
// only matches bare-email format and fails on the more common
// `"Name" <user@example.com>` shape (the `>` breaks `$`). The form below
// terminates on `>` or whitespace OR end-of-string and lowercases for
// canonical comparison.
const SENDER_DOMAIN_RE = /@([\w.-]+?)(?:[>\s]|$)/;

export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === lower) {
      return h.value ?? undefined;
    }
  }
  return undefined;
}

export function parseSenderDomain(fromHeader: string | undefined): string | undefined {
  if (!fromHeader) return undefined;
  const m = fromHeader.match(SENDER_DOMAIN_RE);
  return m ? m[1].toLowerCase() : undefined;
}

export function hasAttachmentParts(payload: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!payload) return false;
  // Inline images come through as `filename: ""` with a Content-ID header —
  // exclude those; they aren't user-perceptible attachments.
  if (payload.filename && payload.filename.length > 0) return true;
  for (const part of payload.parts ?? []) {
    if (hasAttachmentParts(part)) return true;
  }
  return false;
}

export function parseThread(raw: gmail_v1.Schema$Thread): GmailThread {
  if (!raw.id) {
    throw new AppError('GMAIL_PARSE_ERROR', 'thread missing id', 502);
  }
  const messages = raw.messages ?? [];
  if (messages.length === 0) {
    throw new AppError('GMAIL_PARSE_ERROR', 'thread has no messages', 502);
  }

  const first = messages[0];
  const last = messages[messages.length - 1];
  const subject = getHeader(first.payload?.headers, 'Subject') ?? '';
  const from = getHeader(last.payload?.headers, 'From');

  const seenLabels = new Set<string>();
  for (const m of messages) {
    for (const id of m.labelIds ?? []) seenLabels.add(id);
  }

  const internalDate = last.internalDate;
  const latestDate = internalDate ? new Date(parseInt(internalDate, 10)).toISOString() : '';

  return {
    id: raw.id,
    subject,
    latestSnippet: last.snippet ?? '',
    latestSender: from ?? '',
    latestSenderDomain: parseSenderDomain(from),
    latestDate,
    isUnread: messages.some((m) => (m.labelIds ?? []).includes('UNREAD')),
    hasAttachments: messages.some((m) => hasAttachmentParts(m.payload)),
    messageCount: messages.length,
    labelIds: Array.from(seenLabels),
  };
}
