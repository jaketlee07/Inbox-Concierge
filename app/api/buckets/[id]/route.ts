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
  reassignToBucketName: z.string().trim().min(1).max(64),
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const { id: bucketId } = await params;
    if (!bucketId || typeof bucketId !== 'string') {
      throw new ValidationError('Missing bucket id');
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthError();

    const limit = await queueMutationLimiter.limit(user.id);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
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
    const { reassignToBucketName } = parsed.data;

    const { data: bucket, error: bucketErr } = await supabase
      .from('buckets')
      .select('id, name, is_system')
      .eq('id', bucketId)
      .eq('user_id', user.id)
      .single();
    if (bucketErr || !bucket) {
      throw new NotFoundError('Bucket not found');
    }
    if ((bucket as { is_system: boolean }).is_system) {
      throw new ValidationError('Cannot delete a default bucket');
    }
    if ((bucket as { name: string }).name === reassignToBucketName) {
      throw new ValidationError('Reassign target must be a different bucket');
    }

    const { data: target, error: targetErr } = await supabase
      .from('buckets')
      .select('id')
      .eq('user_id', user.id)
      .eq('name', reassignToBucketName)
      .single();
    if (targetErr || !target) {
      throw new NotFoundError(`Bucket "${reassignToBucketName}" not found`);
    }
    const targetId = (target as { id: string }).id;

    const { data: reassigned, error: reassignErr } = await supabase
      .from('classifications')
      .update({ bucket_id: targetId })
      .eq('user_id', user.id)
      .eq('bucket_id', bucketId)
      .select('id');
    if (reassignErr) {
      throw new AppError(
        'DB_UPDATE_FAILED',
        'Failed to reassign classifications',
        500,
        reassignErr,
      );
    }
    const reassignedCount = reassigned?.length ?? 0;

    const { error: deleteErr } = await supabase
      .from('buckets')
      .delete()
      .eq('id', bucketId)
      .eq('user_id', user.id);
    if (deleteErr) {
      throw new AppError('DB_DELETE_FAILED', 'Failed to delete bucket', 500, deleteErr);
    }

    logger.info('buckets.delete.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { ok: true, reassignedCount },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    logger.error(
      'buckets.delete.failed',
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
