// Production classification pipeline. POST → SSE stream.
//
// Pre-stream gates (return JSON on failure): auth, rate limit, Zod body.
// Pre-stream data fetch (also JSON): pending threads, buckets, profile
// thresholds, Gmail re-hydration. Once the stream opens, all subsequent
// failures emit SSE events (`batch_failed`, `pipeline_error`).
//
// Client disconnect: `request.signal.aborted` gates SSE writes only. In-flight
// Promise chains (Claude → parser → executor → DB → Gmail) keep running to
// completion — DB writes still land. The orchestrator has no abort hook by
// design.
//
// Override summary: deferred. The `overrides` table doesn't exist yet —
// passing '' until Phase 5's override-capture UI lands the table + reader.

import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GmailClient } from '@/lib/gmail/client';
import { classifyLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';
import { getThreadsToClassify, markBatchFailed } from '@/lib/pipeline/idempotency';
import { runBatches } from '@/lib/pipeline/batch';
import { executeClassification, type ExecutionResult } from '@/lib/pipeline/executor';
import { buildExecutorDeps } from '@/lib/pipeline/deps';
import type { GmailThread } from '@/types/thread';

const BodySchema = z.object({
  force: z.boolean().optional(),
});

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();

  // ── Pre-stream gates ─────────────────────────────────────────────────────
  let userId: string;
  let force: boolean;
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthError();
    userId = user.id;

    const limit = await classifyLimiter.limit(userId);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      logger.warn('classify.rate_limited', { userId, requestId });
      return NextResponse.json(
        { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
        {
          status: 429,
          headers: { 'x-request-id': requestId, 'Retry-After': String(retryAfter) },
        },
      );
    }

    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError('Invalid request body');
    force = parsed.data.force ?? false;
  } catch (err) {
    logger.error(
      'classify.pre_stream_failed',
      { requestId, errorCode: isAppError(err) ? err.code : 'UNKNOWN' },
      err,
    );
    const { error, statusCode } = toErrorResponse(err);
    return NextResponse.json(
      { error },
      { status: statusCode, headers: { 'x-request-id': requestId } },
    );
  }

  // ── Pre-stream data fetch ────────────────────────────────────────────────
  let pendingThreads: Awaited<ReturnType<typeof getThreadsToClassify>>;
  let bucketIdByName: Map<string, string>;
  let bucketNames: string[];
  let thresholds: { autoExecute: number; queue: number };
  try {
    const [threadsRes, bucketsRes, profileRes] = await Promise.all([
      getThreadsToClassify(supabase, userId, force),
      supabase.from('buckets').select('id, name').order('sort_order'),
      supabase
        .from('profiles')
        .select('auto_execute_threshold, review_threshold')
        .eq('id', userId)
        .single(),
    ]);

    if (bucketsRes.error || profileRes.error || !profileRes.data) {
      logger.error('classify.metadata_query_failed', { userId, requestId });
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: 'Internal error' } },
        { status: 500, headers: { 'x-request-id': requestId } },
      );
    }

    pendingThreads = threadsRes;
    bucketIdByName = new Map<string, string>();
    bucketNames = [];
    for (const b of bucketsRes.data) {
      bucketIdByName.set(b.name, b.id);
      bucketNames.push(b.name);
    }
    thresholds = {
      autoExecute: Number(profileRes.data.auto_execute_threshold),
      queue: Number(profileRes.data.review_threshold),
    };
  } catch (err) {
    logger.error(
      'classify.pre_stream_data_failed',
      { userId, requestId, errorCode: isAppError(err) ? err.code : 'UNKNOWN' },
      err,
    );
    const { error, statusCode } = toErrorResponse(err);
    return NextResponse.json(
      { error },
      { status: statusCode, headers: { 'x-request-id': requestId } },
    );
  }

  const dbThreadIdByGmail = new Map<string, string>();
  for (const t of pendingThreads) {
    dbThreadIdByGmail.set(t.gmail_thread_id, t.id);
  }

  // 0-pending fast path: open a stream, emit pipeline_started + a single
  // pipeline_complete, close. Same event vocabulary as the normal path so
  // the client doesn't need branching.
  if (pendingThreads.length === 0) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(sseFrame('pipeline_started', { total: 0, hydrationFailed: 0 })),
        );
        controller.enqueue(
          encoder.encode(
            sseFrame('pipeline_complete', { autoExecuted: 0, queued: 0, bucketed: 0, failed: 0 }),
          ),
        );
        controller.close();
      },
    });
    return new Response(stream, { headers: { ...SSE_HEADERS, 'x-request-id': requestId } });
  }

  // ── Gmail re-hydration ───────────────────────────────────────────────────
  const gmail = new GmailClient(userId);
  const gmailThreadIds = pendingThreads.map((t) => t.gmail_thread_id);
  const settled = await Promise.allSettled(gmailThreadIds.map((id) => gmail.getThreadMetadata(id)));
  const hydrated: GmailThread[] = [];
  let hydrationFailedCount = 0;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      hydrated.push(r.value);
    } else {
      hydrationFailedCount += 1;
      logger.warn('classify.hydrate_failed', {
        userId,
        requestId,
        threadId: gmailThreadIds[i],
        errorCode: isAppError(r.reason) ? r.reason.code : 'UNKNOWN',
      });
    }
  }

  if (hydrated.length === 0) {
    return NextResponse.json(
      { error: { code: 'HYDRATION_FAILED', message: 'All threads failed to hydrate' } },
      { status: 502, headers: { 'x-request-id': requestId } },
    );
  }

  // ── Open SSE stream ──────────────────────────────────────────────────────
  const deps = buildExecutorDeps(supabase, gmail);
  const startedAt = Date.now();

  let autoExecuted = 0;
  let queued = 0;
  let bucketed = 0;
  // Hydration drops are pipeline-level failures the client should see in the
  // final summary; they never made it to a batch.
  let failed = hydrationFailedCount;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let streamOpen = true;
      const send = (event: string, data: unknown): void => {
        if (!streamOpen || request.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        } catch {
          streamOpen = false;
        }
      };

      // Frame zero: announce total upfront so the client can render a
      // determinate progress bar from the first batch onward.
      send('pipeline_started', {
        total: hydrated.length,
        hydrationFailed: hydrationFailedCount,
      });

      try {
        await runBatches(hydrated, bucketNames, '', async (result) => {
          if (result.status === 'failed') {
            const dbIds = result.threadIds
              .map((g) => dbThreadIdByGmail.get(g))
              .filter((x): x is string => Boolean(x));
            try {
              await markBatchFailed(supabase, dbIds, result.errorCode);
            } catch (markErr) {
              logger.error('classify.mark_failed_failed', {
                userId,
                requestId,
                errorCode: isAppError(markErr) ? markErr.code : 'UNKNOWN',
              });
            }
            failed += result.threadIds.length;
            send('batch_failed', {
              threadIds: result.threadIds,
              errorCode: result.errorCode,
            });
            return;
          }

          // Success path: run executor per-thread. Executor is the per-thread
          // source of truth for `threads.classification_status` (executed |
          // queued | classified) — calling `markBatchClassified` here would
          // overwrite that, so we don't.
          //
          // Each entry carries enough for the client to render the inbox
          // (bucket badge + executor status) without a follow-up DB query.
          // Reasoning text is allowed in this response (the user owns the
          // session); it is never persisted to Postgres.
          const executionResults: {
            threadId: string;
            bucket: string;
            confidence: number;
            recommendedAction: 'archive' | 'label' | 'keep_inbox' | 'none';
            reasoning: string;
            status: ExecutionResult['status'];
          }[] = [];
          for (const c of result.classifications) {
            const dbThreadId = dbThreadIdByGmail.get(c.threadId);
            const bucketId = bucketIdByName.get(c.bucket);
            if (!dbThreadId || !bucketId) {
              logger.warn('classify.lookup_missing', {
                userId,
                requestId,
                threadId: c.threadId,
              });
              continue;
            }
            try {
              const er = await executeClassification(c, thresholds, {
                userId,
                dbThreadId,
                bucketId,
                ...deps,
              });
              executionResults.push({
                threadId: c.threadId,
                bucket: c.bucket,
                confidence: c.confidence,
                recommendedAction: c.recommendedAction,
                reasoning: c.reasoning,
                status: er.status,
              });
              if (er.status === 'auto_executed') autoExecuted += 1;
              else if (er.status === 'queued') queued += 1;
              else bucketed += 1;
            } catch (execErr) {
              logger.error('classify.executor_failed', {
                userId,
                requestId,
                threadId: c.threadId,
                errorCode: isAppError(execErr) ? execErr.code : 'UNKNOWN',
              });
              failed += 1;
            }
          }

          send('batch_complete', {
            threadIds: result.threadIds,
            executionResults,
          });
        });

        send('pipeline_complete', { autoExecuted, queued, bucketed, failed });
        logger.info('classify.complete', {
          userId,
          requestId,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        logger.error(
          'classify.pipeline_error',
          {
            userId,
            requestId,
            durationMs: Date.now() - startedAt,
            errorCode: isAppError(err) ? err.code : 'UNKNOWN',
          },
          err,
        );
        send('pipeline_error', {
          errorCode: isAppError(err) ? err.code : 'UNKNOWN',
        });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: { ...SSE_HEADERS, 'x-request-id': requestId },
  });
}
