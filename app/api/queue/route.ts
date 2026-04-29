import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { gmailFetchLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AuthError, isAppError, toErrorResponse } from '@/lib/errors';

type DbAction = 'archive' | 'label' | 'none';

interface QueueItem {
  queueId: string;
  classificationId: string;
  threadId: string;
  bucket: string;
  confidence: number;
  recommendedAction: DbAction;
}

interface QueueRow {
  id: string;
  classification_id: string;
  classifications: {
    confidence: number | string;
    recommended_action: DbAction;
    threads: { gmail_thread_id: string };
    buckets: { name: string };
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      throw new AuthError();
    }

    const limit = await gmailFetchLimiter.limit(user.id);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      logger.warn('queue.list.rate_limited', { userId: user.id, requestId });
      return NextResponse.json(
        { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
        {
          status: 429,
          headers: { 'x-request-id': requestId, 'Retry-After': String(retryAfter) },
        },
      );
    }

    const { data, error } = await supabase
      .from('review_queue')
      .select(
        `id, classification_id, classifications!inner(confidence, recommended_action, threads!inner(gmail_thread_id), buckets!inner(name))`,
      )
      .eq('user_id', user.id)
      .eq('status', 'pending');

    if (error) {
      logger.error('queue.list.read_failed', { userId: user.id, requestId }, error);
      return NextResponse.json(
        { error: { code: 'DB_READ_FAILED', message: 'Failed to load review queue' } },
        { status: 500, headers: { 'x-request-id': requestId } },
      );
    }

    const items: QueueItem[] = ((data ?? []) as unknown as QueueRow[]).map((row) => ({
      queueId: row.id,
      classificationId: row.classification_id,
      threadId: row.classifications.threads.gmail_thread_id,
      bucket: row.classifications.buckets.name,
      confidence: Number(row.classifications.confidence),
      recommendedAction: row.classifications.recommended_action,
    }));

    items.sort((a, b) => a.confidence - b.confidence);

    logger.info('queue.list.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
      count: items.length,
    });

    return NextResponse.json({ items }, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'queue.list.failed',
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
