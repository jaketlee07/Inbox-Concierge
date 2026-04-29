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
  bucketName: z.string().min(1).max(64),
});

interface QueueRow {
  id: string;
  status: string;
  classification_id: string;
  classifications: {
    id: string;
    bucket_id: string;
    threads: { id: string; gmail_thread_id: string };
  };
}

interface BucketRow {
  id: string;
  name: string;
  default_action: DbAction | null;
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
      logger.warn('queue.override.rate_limited', { userId: user.id, requestId });
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
    const { queueId, bucketName } = parsed.data;

    const { data: rowRaw, error: readErr } = await supabase
      .from('review_queue')
      .select(
        `id, status, classification_id, classifications!inner(id, bucket_id, threads!inner(id, gmail_thread_id))`,
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
    const originalBucketId = row.classifications.bucket_id;
    const dbThreadId = row.classifications.threads.id;
    const gmailThreadId = row.classifications.threads.gmail_thread_id;

    const { data: bucketRaw, error: bucketErr } = await supabase
      .from('buckets')
      .select('id, name, default_action')
      .eq('user_id', user.id)
      .eq('name', bucketName)
      .single();
    if (bucketErr || !bucketRaw) {
      throw new NotFoundError(`Bucket "${bucketName}" not found`);
    }
    const newBucket = bucketRaw as BucketRow;
    const newBucketId = newBucket.id;
    const action: DbAction = newBucket.default_action ?? 'none';

    logger.info('queue.override.start', {
      userId: user.id,
      requestId,
      queueId,
      from: originalBucketId,
      to: newBucketId,
      action,
    });

    const { error: ovErr } = await supabase.from('overrides').insert({
      user_id: user.id,
      classification_id: classificationId,
      original_bucket_id: originalBucketId,
      new_bucket_id: newBucketId,
    });
    if (ovErr) {
      throw new AppError('DB_INSERT_FAILED', 'Failed to log override', 500, ovErr);
    }

    const { error: classBucketErr } = await supabase
      .from('classifications')
      .update({ bucket_id: newBucketId })
      .eq('id', classificationId);
    if (classBucketErr) {
      throw new AppError(
        'DB_UPDATE_FAILED',
        'Failed to update classification bucket',
        500,
        classBucketErr,
      );
    }

    const client = new GmailClient(user.id);
    if (action === 'archive') {
      await client.archiveThread(gmailThreadId);
    } else if (action === 'label') {
      await client.addLabel(gmailThreadId, newBucket.name);
    }

    const nowIso = new Date().toISOString();
    if (action !== 'none') {
      const { error: classExecErr } = await supabase
        .from('classifications')
        .update({ executed_action: action, executed_at: nowIso })
        .eq('id', classificationId);
      if (classExecErr) {
        throw new AppError(
          'DB_UPDATE_FAILED',
          'Failed to mark classification executed',
          500,
          classExecErr,
        );
      }
    }

    const { error: threadErr } = await supabase
      .from('threads')
      .update({ classification_status: action !== 'none' ? 'executed' : 'classified' })
      .eq('id', dbThreadId);
    if (threadErr) {
      throw new AppError('DB_UPDATE_FAILED', 'Failed to update thread status', 500, threadErr);
    }

    const { error: queueErr } = await supabase
      .from('review_queue')
      .update({ status: 'overridden', resolved_at: nowIso })
      .eq('id', queueId);
    if (queueErr) {
      throw new AppError('DB_UPDATE_FAILED', 'Failed to update review queue', 500, queueErr);
    }

    logger.info('queue.override.complete', {
      userId: user.id,
      requestId,
      queueId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ ok: true }, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'queue.override.failed',
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
