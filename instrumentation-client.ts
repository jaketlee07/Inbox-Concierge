import * as Sentry from '@sentry/nextjs';
import { beforeSend } from './lib/sentry/scrub';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Replay would visually capture rendered email content in the inbox UI.
    // Both rates explicitly zero. Do not add the Replay integration.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,
    beforeSend,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
