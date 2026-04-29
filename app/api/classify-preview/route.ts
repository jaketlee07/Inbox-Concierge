// PREVIEW endpoint — does NOT persist classifications, does NOT execute Gmail
// actions. Pure read-and-return for UI verification. Phase 4.7's production
// /api/classify route is the SSE-streaming, idempotent, executor-driven
// surface; this route exists so the inbox UI can show classifications today
// without preempting that design.

import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GmailClient } from '@/lib/gmail/client';
import { classifyBatch } from '@/lib/claude/client';
import { parseClassifyResult } from '@/lib/claude/parser';
import { classifyPreviewLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';
import type { GmailThread } from '@/types/thread';

const BodySchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(20),
});

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

    // RLS on `threads` filters to rows owned by the authenticated user, so
    // this query naturally drops any IDs the caller doesn't own.
    const { data: ownedRows, error: ownErr } = await supabase
      .from('threads')
      .select('gmail_thread_id')
      .in('gmail_thread_id', threadIds);
    if (ownErr) {
      logger.error('classify_preview.threads_query_failed', { userId: user.id, requestId }, ownErr);
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: 'Internal error' } },
        { status: 500, headers: { 'x-request-id': requestId } },
      );
    }
    const ownedSet = new Set(ownedRows.map((r) => r.gmail_thread_id));
    const validThreadIds = threadIds.filter((id) => ownedSet.has(id));
    if (validThreadIds.length === 0) {
      throw new ValidationError('No matching threads found');
    }

    const { data: bucketRows, error: bucketsErr } = await supabase
      .from('buckets')
      .select('name')
      .order('sort_order');
    if (bucketsErr || !bucketRows) {
      logger.error(
        'classify_preview.buckets_query_failed',
        { userId: user.id, requestId },
        bucketsErr,
      );
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: 'Internal error' } },
        { status: 500, headers: { 'x-request-id': requestId } },
      );
    }
    const bucketNames = bucketRows.map((b) => b.name);

    // Re-hydrate metadata server-side. The client cannot be trusted to
    // round-trip subject/sender — we always re-read from Gmail.
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

    const raw = await classifyBatch(hydrated, bucketNames, '');
    const classifications = parseClassifyResult(
      raw,
      hydrated.map((t) => t.id),
      bucketNames,
    );

    logger.info('classify_preview.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { classifications, hydrationFailed },
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
