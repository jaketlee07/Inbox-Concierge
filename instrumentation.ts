import type { Instrumentation } from 'next';

export async function register(): Promise<void> {
  if (!process.env.SENTRY_DSN) return;

  const Sentry = await import('@sentry/nextjs');
  const { beforeSend } = await import('./lib/sentry/scrub');

  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      sendDefaultPii: false,
      beforeSend,
    });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (!process.env.SENTRY_DSN) return;
  const { captureRequestError } = await import('@sentry/nextjs');
  await captureRequestError(err, request, context);
};
