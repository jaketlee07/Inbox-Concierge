import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GmailClient } from '@/lib/gmail/client';
import { gmailMutationLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AppError, AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';

const BodySchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(50),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
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

    const limit = await gmailMutationLimiter.limit(user.id);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      logger.warn('gmail.archive.rate_limited', { userId: user.id, requestId });
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
    if (!parsed.success) {
      throw new ValidationError('Invalid request body');
    }
    const { threadIds } = parsed.data;

    logger.info('gmail.archive.start', { userId: user.id, requestId });

    const client = new GmailClient(user.id);
    const settled = await Promise.allSettled(threadIds.map((id) => client.archiveThread(id)));

    const archived: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const threadId = threadIds[i];
      if (r.status === 'fulfilled') {
        archived.push(threadId);
      } else {
        failed.push(threadId);
        logger.warn('gmail.archive.thread_failed', {
          userId: user.id,
          requestId,
          threadId,
          errorCode: isAppError(r.reason) ? r.reason.code : 'UNKNOWN',
        });
      }
    }

    if (archived.length > 0) {
      const { error: updateErr } = await supabase
        .from('threads')
        .update({ classification_status: 'executed' })
        .eq('user_id', user.id)
        .in('gmail_thread_id', archived);
      if (updateErr) {
        logger.error('gmail.archive.db_update_failed', { userId: user.id, requestId }, updateErr);
        throw new AppError('DB_UPDATE_FAILED', 'Failed to record archive status', 500, updateErr);
      }
    }

    logger.info('gmail.archive.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ archived, failed }, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'gmail.archive.failed',
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
