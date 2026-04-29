'use client';

import * as Sentry from '@sentry/nextjs';

export type UserActionName =
  | 'classify_started'
  | 'queue_approve'
  | 'queue_override'
  | 'queue_dismiss'
  | 'bucket_created'
  | 'bucket_deleted'
  | 'settings_saved'
  | 'sign_out';

// Records a breadcrumb for production observability. Sentry's beforeSend in
// lib/sentry/scrub.ts already filters breadcrumb data fields against the
// allowlist — call sites pass values freely.
export function recordUserAction(
  name: UserActionName,
  data?: Record<string, string | number | boolean>,
): void {
  Sentry.addBreadcrumb({
    category: 'user_action',
    level: 'info',
    message: name,
    data,
  });
}
