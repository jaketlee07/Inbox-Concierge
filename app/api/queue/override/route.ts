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

    // Reads are independent — both keyed only on body params. Parallelize so
    // we pay one round-trip instead of two before the validation gate.
    const [queueRead, bucketRead] = await Promise.all([
      supabase
        .from('review_queue')
        .select(
          `id, status, classification_id, classifications!inner(id, bucket_id, threads!inner(id, gmail_thread_id))`,
        )
        .eq('id', queueId)
        .eq('user_id', user.id)
        .single(),
      supabase
        .from('buckets')
        .select('id, name, default_action')
        .eq('user_id', user.id)
        .eq('name', bucketName)
        .single(),
    ]);

    if (queueRead.error || !queueRead.data) {
      throw new NotFoundError('Review item not found');
    }
    const row = queueRead.data as unknown as QueueRow;
    if (row.status !== 'pending') {
      throw new ValidationError(`Review item already ${row.status}`);
    }

    if (bucketRead.error || !bucketRead.data) {
      throw new NotFoundError(`Bucket "${bucketName}" not found`);
    }
    const newBucket = bucketRead.data as BucketRow;

    const classificationId = row.classifications.id;
    const originalBucketId = row.classifications.bucket_id;
    const dbThreadId = row.classifications.threads.id;
    const gmailThreadId = row.classifications.threads.gmail_thread_id;
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

    // Audit log + bucket update are independent — parallelize. Both must
    // succeed before the Gmail action so a failed Gmail call leaves a
    // consistent record of intent.
    const [ovRes, classBucketRes] = await Promise.all([
      supabase.from('overrides').insert({
        user_id: user.id,
        classification_id: classificationId,
        original_bucket_id: originalBucketId,
        new_bucket_id: newBucketId,
      }),
      supabase
        .from('classifications')
        .update({ bucket_id: newBucketId })
        .eq('id', classificationId),
    ]);
    if (ovRes.error) {
      throw new AppError('DB_INSERT_FAILED', 'Failed to log override', 500, ovRes.error);
    }
    if (classBucketRes.error) {
      throw new AppError(
        'DB_UPDATE_FAILED',
        'Failed to update classification bucket',
        500,
        classBucketRes.error,
      );
    }

    const client = new GmailClient(user.id);
    if (action === 'archive') {
      await client.archiveThread(gmailThreadId);
    } else if (action === 'label') {
      await client.addLabel(gmailThreadId, newBucket.name);
    }

    const nowIso = new Date().toISOString();
    // Trailing 3 writes are independent — parallelize.
    const [classExecRes, threadRes, queueRes] = await Promise.all([
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
        .update({ status: 'overridden', resolved_at: nowIso })
        .eq('id', queueId),
    ]);
    if (classExecRes.error) {
      throw new AppError(
        'DB_UPDATE_FAILED',
        'Failed to mark classification executed',
        500,
        classExecRes.error,
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
