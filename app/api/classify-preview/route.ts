// PREVIEW endpoint — dry-runs the full pipeline (classify → parse → executor)
// with NO-OP deps so the executor's branching logic decides each thread's
// fate without persisting classifications or firing real Gmail actions.
// Phase 4.7's production /api/classify route is the streaming, idempotent,
// for-real surface; this route exists so the inbox UI can show what WOULD
// happen today.

import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GmailClient } from '@/lib/gmail/client';
import { classifyBatch } from '@/lib/claude/client';
import { parseClassifyResult } from '@/lib/claude/parser';
import {
  executeClassification,
  type ExecutionResult,
  type ExecutorContext,
} from '@/lib/pipeline/executor';
import { classifyPreviewLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';
import type { GmailThread } from '@/types/thread';

const BodySchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(20),
});

// Deps that don't touch Postgres or Gmail. The executor's branching logic
// still runs end-to-end; tests show what the production pipeline would do.
const noopDeps: Pick<
  ExecutorContext,
  | 'insertClassification'
  | 'markClassificationExecuted'
  | 'insertReviewQueue'
  | 'setThreadStatus'
  | 'archiveGmail'
  | 'addGmailLabel'
> = {
  insertClassification: async () => 'preview_classification_id',
  markClassificationExecuted: async () => {},
  insertReviewQueue: async () => {},
  setThreadStatus: async () => {},
  archiveGmail: async () => {},
  addGmailLabel: async () => {},
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthError();

    const limit = await classifyPreviewLimiter.limit(user.id);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      logger.warn('classify_preview.rate_limited', { userId: user.id, requestId });
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
    const { threadIds } = parsed.data;

    // Parallel reads: thread ownership + bucket list + profile thresholds.
    const [threadsRes, bucketsRes, profileRes] = await Promise.all([
      supabase.from('threads').select('id, gmail_thread_id').in('gmail_thread_id', threadIds),
      supabase.from('buckets').select('id, name, description').order('sort_order'),
      supabase
        .from('profiles')
        .select('auto_execute_threshold, review_threshold')
        .eq('id', user.id)
        .single(),
    ]);

    if (threadsRes.error || bucketsRes.error || profileRes.error) {
      logger.error('classify_preview.metadata_query_failed', {
        userId: user.id,
        requestId,
      });
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: 'Internal error' } },
        { status: 500, headers: { 'x-request-id': requestId } },
      );
    }

    const dbThreadIdByGmail = new Map<string, string>();
    for (const row of threadsRes.data) {
      dbThreadIdByGmail.set(row.gmail_thread_id, row.id);
    }
    const validThreadIds = threadIds.filter((id) => dbThreadIdByGmail.has(id));
    if (validThreadIds.length === 0) {
      throw new ValidationError('No matching threads found');
    }

    const bucketIdByName = new Map<string, string>();
    const bucketNames: string[] = [];
    const bucketsForPrompt: { name: string; description: string }[] = [];
    for (const b of bucketsRes.data as { id: string; name: string; description: string }[]) {
      bucketIdByName.set(b.name, b.id);
      bucketNames.push(b.name);
      bucketsForPrompt.push({ name: b.name, description: b.description });
    }

    const thresholds = {
      autoExecute: Number(profileRes.data.auto_execute_threshold),
      queue: Number(profileRes.data.review_threshold),
    };

    // Re-hydrate metadata server-side. Client cannot be trusted to round-trip
    // subject/sender — re-read from Gmail every call.
    const gmail = new GmailClient(user.id);
    const settled = await Promise.allSettled(
      validThreadIds.map((id) => gmail.getThreadMetadata(id)),
    );
    const hydrated: GmailThread[] = [];
    const hydrationFailed: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        hydrated.push(r.value);
      } else {
        hydrationFailed.push(validThreadIds[i]);
        logger.warn('classify_preview.hydrate_failed', {
          userId: user.id,
          requestId,
          threadId: validThreadIds[i],
          errorCode: isAppError(r.reason) ? r.reason.code : 'UNKNOWN',
        });
      }
    }
    if (hydrated.length === 0) {
      throw new ValidationError('All threads failed to hydrate');
    }

    const raw = await classifyBatch(hydrated, bucketsForPrompt, '');
    const classifications = parseClassifyResult(
      raw,
      hydrated.map((t) => t.id),
      bucketNames,
    );

    // Dry-run executor on each classified thread to preview its decision.
    const executorResults: { threadId: string; status: ExecutionResult['status'] }[] = [];
    for (const c of classifications) {
      const dbThreadId = dbThreadIdByGmail.get(c.threadId);
      const bucketId = bucketIdByName.get(c.bucket);
      if (!dbThreadId || !bucketId) continue;
      const result = await executeClassification(c, thresholds, {
        userId: user.id,
        dbThreadId,
        bucketId,
        ...noopDeps,
      });
      executorResults.push({ threadId: c.threadId, status: result.status });
    }

    logger.info('classify_preview.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { classifications, executorResults, hydrationFailed },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    logger.error(
      'classify_preview.failed',
      {
        requestId,
        durationMs: Date.now() - startedAt,
        errorCode: isAppError(err) ? err.code : 'UNKNOWN',
      },
      err,
    );
    const { error, statusCode } = toErrorResponse(err);
    return NextResponse.json(
      { error },
      { status: statusCode, headers: { 'x-request-id': requestId } },
    );
  }
}
