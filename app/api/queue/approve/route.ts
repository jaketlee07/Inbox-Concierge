import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GmailClient } from '@/lib/gmail/client';
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

type DbAction = 'archive' | 'label' | 'none';

const BodySchema = z.object({
  queueId: z.string().uuid(),
});

interface QueueRow {
  id: string;
  status: string;
  classification_id: string;
  classifications: {
    id: string;
    recommended_action: DbAction;
    thread_id: string;
    threads: { id: string; gmail_thread_id: string };
    buckets: { name: string };
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
      logger.warn('queue.approve.rate_limited', { userId: user.id, requestId });
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
      .select(
        `id, status, classification_id, classifications!inner(id, recommended_action, thread_id, threads!inner(id, gmail_thread_id), buckets!inner(name))`,
      )
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

    const classificationId = row.classifications.id;
    const dbThreadId = row.classifications.threads.id;
    const gmailThreadId = row.classifications.threads.gmail_thread_id;
    const action = row.classifications.recommended_action;
    const bucketName = row.classifications.buckets.name;

    logger.info('queue.approve.start', {
      userId: user.id,
      requestId,
      queueId,
      action,
      bucketName,
    });

    const client = new GmailClient(user.id);
    if (action === 'archive') {
      await client.archiveThread(gmailThreadId);
    } else if (action === 'label') {
      await client.addLabel(gmailThreadId, bucketName);
    }

    const nowIso = new Date().toISOString();
    // The 3 trailing writes are independent — parallelize so a slow Supabase
    // round-trip doesn't gate the next, dropping mutation latency from
    // ~1.5–2.4 s of stacked round-trips to a single round-trip's worth.
    const [classRes, threadRes, queueRes] = await Promise.all([
      action !== 'none'
        ? supabase
            .from('classifications')
            .update({ executed_action: action, executed_at: nowIso })
            .eq('id', classificationId)
        : Promise.resolve({ error: null }),
      supabase
        .from('threads')
        .update({ classification_status: action !== 'none' ? 'executed' : 'classified' })
        .eq('id', dbThreadId),
      supabase
        .from('review_queue')
        .update({ status: 'approved', resolved_at: nowIso })
        .eq('id', queueId),
    ]);
    if (classRes.error) {
      throw new AppError(
        'DB_UPDATE_FAILED',
        'Failed to update classification',
        500,
        classRes.error,
      );
    }
    if (threadRes.error) {
      throw new AppError(
        'DB_UPDATE_FAILED',
        'Failed to update thread status',
        500,
        threadRes.error,
      );
    }
    if (queueRes.error) {
      throw new AppError('DB_UPDATE_FAILED', 'Failed to update review queue', 500, queueRes.error);
    }

    logger.info('queue.approve.complete', {
      userId: user.id,
      requestId,
      queueId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ ok: true }, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'queue.approve.failed',
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
