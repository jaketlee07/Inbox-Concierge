import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
};

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  // Source map upload requires SENTRY_AUTH_TOKEN, org, project. Disabled until configured.
  sourcemaps: { disable: true },
});
