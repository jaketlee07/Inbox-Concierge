import 'server-only';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from './env';

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

// 5 fetch-threads requests per 60 seconds, per user. Sliding window so a
// burst-then-pause pattern doesn't trick a fixed-window edge.
export const gmailFetchLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '60 s'),
  prefix: 'gmail:fetch',
  analytics: false,
});
