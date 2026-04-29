import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queueMutationLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import {
  AppError,
  AuthError,
  ValidationError,
  NotFoundError,
  isAppError,
  toErrorResponse,
} from '@/lib/errors';

const BodySchema = z.object({
  queueId: z.string().uuid(),
});

interface QueueRow {
  id: string;
  status: string;
  classifications: {
    threads: { id: string };
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthError();

    const limit = await queueMutationLimiter.limit(user.id);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      logger.warn('queue.dismiss.rate_limited', { userId: user.id, requestId });
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
    const { queueId } = parsed.data;

    const { data: rowRaw, error: readErr } = await supabase
      .from('review_queue')
      .select(`id, status, classifications!inner(threads!inner(id))`)
      .eq('id', queueId)
      .eq('user_id', user.id)
      .single();
    if (readErr || !rowRaw) {
      throw new NotFoundError('Review item not found');
    }
    const row = rowRaw as unknown as QueueRow;
    if (row.status !== 'pending') {
      throw new ValidationError(`Review item already ${row.status}`);
    }

    const dbThreadId = row.classifications.threads.id;
    const nowIso = new Date().toISOString();

    const { error: threadErr } = await supabase
      .from('threads')
      .update({ classification_status: 'classified' })
      .eq('id', dbThreadId);
    if (threadErr) {
      throw new AppError('DB_UPDATE_FAILED', 'Failed to update thread status', 500, threadErr);
    }

    const { error: queueErr } = await supabase
      .from('review_queue')
      .update({ status: 'dismissed', resolved_at: nowIso })
      .eq('id', queueId);
    if (queueErr) {
      throw new AppError('DB_UPDATE_FAILED', 'Failed to update review queue', 500, queueErr);
    }

    logger.info('queue.dismiss.complete', {
      userId: user.id,
      requestId,
      queueId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ ok: true }, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'queue.dismiss.failed',
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
