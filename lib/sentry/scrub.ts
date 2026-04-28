import type { ErrorEvent, EventHint } from '@sentry/nextjs';

// Mirrors lib/logger.ts LOG_ALLOWLIST. Keep both in sync — extending one without the other
// breaks the privacy contract that says logs and Sentry events strip the same fields.
export const SENTRY_DATA_ALLOWLIST: ReadonlySet<string> = new Set([
  'threadId',
  'userId',
  'bucket',
  'confidence',
  'action',
  'event',
  'level',
  'timestamp',
  'requestId',
  'durationMs',
  'statusCode',
]);

// Sentry-built-in contexts contain runtime/environment info, no user content.
// Custom contexts (anything not in this set) are dropped entirely.
const SENTRY_BUILTIN_CONTEXTS: ReadonlySet<string> = new Set([
  'runtime',
  'os',
  'browser',
  'app',
  'device',
  'culture',
  'trace',
  'response',
  'state',
  'cloud_resource',
  'gpu',
  'profile',
]);

type Primitive = string | number | boolean | null;

function pickAllowlistedFlat(record: Record<string, unknown>): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  for (const key of Object.keys(record)) {
    if (!SENTRY_DATA_ALLOWLIST.has(key)) continue;
    const value = record[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value;
    }
  }
  return out;
}

export function beforeSend(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  if (event.extra) {
    event.extra = pickAllowlistedFlat(event.extra);
  }

  if (event.tags) {
    event.tags = pickAllowlistedFlat(event.tags) as ErrorEvent['tags'];
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      data: breadcrumb.data ? pickAllowlistedFlat(breadcrumb.data) : undefined,
    }));
  }

  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!SENTRY_BUILTIN_CONTEXTS.has(key)) {
        delete event.contexts[key];
      }
    }
  }

  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }

  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }

  return event;
}
