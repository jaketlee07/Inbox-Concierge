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

// Mutations (archive / label / draft) share one budget. Keeps the user's
// Gmail-side write rate honest without letting any one operation starve the
// others. Distinct prefix from the fetch limiter so a stuck read doesn't
// block writes.
export const gmailMutationLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '60 s'),
  prefix: 'gmail:mutation',
  analytics: false,
});

// Preview classification requests. Each call hits Claude with up to 20
// threads of metadata — heavier than a Gmail call. 5/min/user is generous
// enough for iteration while bounding accidental thrash.
export const classifyPreviewLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '60 s'),
  prefix: 'classify:preview',
  analytics: false,
});

// Production classification: heavy operation (up to 200 threads, multiple
// batches, real DB writes + Gmail actions). 1/min/user matches the spec.
export const classifyLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, '60 s'),
  prefix: 'classify:run',
  analytics: false,
});
