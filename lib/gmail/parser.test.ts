import { describe, expect, it } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { getHeader, hasAttachmentParts, parseSenderDomain, parseThread } from './parser';

type Headers = gmail_v1.Schema$MessagePartHeader[];
type Part = gmail_v1.Schema$MessagePart;
type Message = gmail_v1.Schema$Message;
type Thread = gmail_v1.Schema$Thread;

function header(name: string, value: string): gmail_v1.Schema$MessagePartHeader {
  return { name, value };
}

function msg(opts: {
  id?: string;
  internalDate?: string | null;
  labelIds?: string[];
  snippet?: string;
  headers?: Headers;
  payload?: Part;
}): Message {
  return {
    id: opts.id ?? 'm1',
    internalDate: opts.internalDate === undefined ? '1745683200000' : opts.internalDate,
    labelIds: opts.labelIds ?? [],
    snippet: opts.snippet ?? '',
    payload: opts.payload ?? { headers: opts.headers ?? [] },
  };
}

const APR_28_2026_MS = '1777392000000';

describe('parseSenderDomain', () => {
  it('parses bare email', () => {
    expect(parseSenderDomain('alice@example.com')).toBe('example.com');
  });

  it('parses display-name format', () => {
    expect(parseSenderDomain('"Alice Smith" <alice@example.com>')).toBe('example.com');
  });

  it('lowercases the domain', () => {
    expect(parseSenderDomain('a@Example.COM')).toBe('example.com');
  });

  it('returns undefined for missing header', () => {
    expect(parseSenderDomain(undefined)).toBeUndefined();
  });

  it('returns undefined for malformed (no @)', () => {
    expect(parseSenderDomain('"Bad" <not-an-email>')).toBeUndefined();
  });

  it('handles subdomains', () => {
    expect(parseSenderDomain('foo@mail.substack.com')).toBe('mail.substack.com');
  });
});

describe('getHeader', () => {
  it('matches case-insensitively', () => {
    const headers: Headers = [header('Subject', 'Hi'), header('From', 'a@b.com')];
    expect(getHeader(headers, 'subject')).toBe('Hi');
    expect(getHeader(headers, 'FROM')).toBe('a@b.com');
  });

  it('returns undefined when missing', () => {
    expect(getHeader([], 'Subject')).toBeUndefined();
    expect(getHeader(undefined, 'Subject')).toBeUndefined();
  });
});

describe('hasAttachmentParts', () => {
  it('returns true on top-level attachment', () => {
    const payload: Part = { filename: 'report.pdf' };
    expect(hasAttachmentParts(payload)).toBe(true);
  });

  it('returns false on inline image (empty filename)', () => {
    const payload: Part = {
      parts: [{ filename: '', mimeType: 'image/png', headers: [header('Content-ID', '<x>')] }],
    };
    expect(hasAttachmentParts(payload)).toBe(false);
  });

  it('walks nested parts recursively', () => {
    const payload: Part = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain' },
        {
          mimeType: 'multipart/mixed',
          parts: [{ mimeType: 'text/html' }, { filename: 'doc.pdf' }],
        },
      ],
    };
    expect(hasAttachmentParts(payload)).toBe(true);
  });

  it('returns false on undefined', () => {
    expect(hasAttachmentParts(undefined)).toBe(false);
  });
});

describe('parseThread', () => {
  it('parses a 3-message thread with mixed read/attachment state', () => {
    const thread: Thread = {
      id: 't_abc',
      messages: [
        msg({
          id: 'm1',
          internalDate: '1745683200000',
          labelIds: ['INBOX'],
          snippet: 'older',
          headers: [header('Subject', 'Project status'), header('From', 'a@x.com')],
        }),
        msg({
          id: 'm2',
          internalDate: '1745769600000',
          labelIds: ['INBOX', 'UNREAD'],
          snippet: 'middle',
          payload: {
            headers: [header('From', 'b@y.com')],
            parts: [{ mimeType: 'text/plain' }, { filename: 'attachment.pdf' }],
          },
        }),
        msg({
          id: 'm3',
          internalDate: APR_28_2026_MS,
          labelIds: ['INBOX', 'IMPORTANT'],
          snippet: 'latest reply',
          headers: [header('From', '"Carol" <carol@z.com>')],
        }),
      ],
    };

    const out = parseThread(thread);
    expect(out.id).toBe('t_abc');
    expect(out.subject).toBe('Project status');
    expect(out.latestSnippet).toBe('latest reply');
    expect(out.latestSender).toBe('"Carol" <carol@z.com>');
    expect(out.latestSenderDomain).toBe('z.com');
    expect(out.latestDate).toBe('2026-04-28T16:00:00.000Z');
    expect(out.isUnread).toBe(true);
    expect(out.hasAttachments).toBe(true);
    expect(out.messageCount).toBe(3);
    expect([...out.labelIds].sort()).toEqual(['IMPORTANT', 'INBOX', 'UNREAD']);
  });

  it('parses a single read message', () => {
    const thread: Thread = {
      id: 't_single',
      messages: [
        msg({
          labelIds: ['INBOX'],
          snippet: 'just a note',
          headers: [header('Subject', 'Hello'), header('From', 'one@a.com')],
        }),
      ],
    };
    const out = parseThread(thread);
    expect(out.messageCount).toBe(1);
    expect(out.isUnread).toBe(false);
    expect(out.hasAttachments).toBe(false);
    expect(out.subject).toBe('Hello');
  });

  it('handles missing From header without throwing', () => {
    const thread: Thread = {
      id: 't_no_from',
      messages: [msg({ headers: [header('Subject', 'No From')] })],
    };
    const out = parseThread(thread);
    expect(out.latestSender).toBe('');
    expect(out.latestSenderDomain).toBeUndefined();
  });

  it('handles missing Subject header', () => {
    const thread: Thread = {
      id: 't_no_subj',
      messages: [msg({ headers: [header('From', 'a@b.com')] })],
    };
    expect(parseThread(thread).subject).toBe('');
  });

  it('handles missing internalDate', () => {
    const thread: Thread = {
      id: 't_no_date',
      messages: [msg({ internalDate: null, headers: [header('From', 'a@b.com')] })],
    };
    expect(parseThread(thread).latestDate).toBe('');
  });

  it('detects nested-multipart attachment', () => {
    const thread: Thread = {
      id: 't_nest',
      messages: [
        msg({
          payload: {
            mimeType: 'multipart/alternative',
            headers: [header('From', 'a@b.com')],
            parts: [
              { mimeType: 'text/plain' },
              {
                mimeType: 'multipart/mixed',
                parts: [{ mimeType: 'text/html' }, { filename: 'doc.pdf' }],
              },
            ],
          },
        }),
      ],
    };
    expect(parseThread(thread).hasAttachments).toBe(true);
  });

  it('does NOT flag a thread with only inline images as having attachments', () => {
    const thread: Thread = {
      id: 't_inline',
      messages: [
        msg({
          payload: {
            headers: [header('From', 'a@b.com')],
            parts: [
              { mimeType: 'text/html' },
              {
                filename: '',
                mimeType: 'image/png',
                headers: [header('Content-ID', '<logo>')],
              },
            ],
          },
        }),
      ],
    };
    expect(parseThread(thread).hasAttachments).toBe(false);
  });

  it('throws GMAIL_PARSE_ERROR when no messages', () => {
    expect(() => parseThread({ id: 't_empty', messages: [] })).toThrowError(
      /thread has no messages/,
    );
  });

  it('throws GMAIL_PARSE_ERROR when no id', () => {
    expect(() => parseThread({ messages: [msg({})] })).toThrowError(/thread missing id/);
  });

  it('handles bare-email From', () => {
    const thread: Thread = {
      id: 't_bare',
      messages: [msg({ headers: [header('From', 'noreply@substack.com')] })],
    };
    expect(parseThread(thread).latestSenderDomain).toBe('substack.com');
  });

  it('handles malformed From (no @)', () => {
    const thread: Thread = {
      id: 't_bad',
      messages: [msg({ headers: [header('From', '"Bad" <not-an-email>')] })],
    };
    expect(parseThread(thread).latestSenderDomain).toBeUndefined();
  });

  it('lowercases mixed-case domain', () => {
    const thread: Thread = {
      id: 't_case',
      messages: [msg({ headers: [header('From', 'a@Example.COM')] })],
    };
    expect(parseThread(thread).latestSenderDomain).toBe('example.com');
  });

  it('takes Subject from first message but Sender from last', () => {
    const thread: Thread = {
      id: 't_order',
      messages: [
        msg({
          internalDate: '1000',
          headers: [header('Subject', 'Original'), header('From', 'first@a.com')],
        }),
        msg({
          internalDate: '2000',
          headers: [header('Subject', 'Re: Original'), header('From', 'last@b.com')],
        }),
      ],
    };
    const out = parseThread(thread);
    expect(out.subject).toBe('Original');
    expect(out.latestSender).toBe('last@b.com');
    expect(out.latestSenderDomain).toBe('b.com');
  });
});
