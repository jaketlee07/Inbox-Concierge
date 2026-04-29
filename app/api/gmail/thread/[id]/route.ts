import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { GmailClient } from '@/lib/gmail/client';
import { gmailMutationLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const { id: threadId } = await params;
    if (!threadId || typeof threadId !== 'string') {
      throw new ValidationError('Missing thread id');
    }

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
      logger.warn('gmail.thread.rate_limited', { userId: user.id, requestId });
      return NextResponse.json(
        { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
        {
          status: 429,
          headers: { 'x-request-id': requestId, 'Retry-After': String(retryAfter) },
        },
      );
    }

    const client = new GmailClient(user.id);
    const thread = await client.getThreadMetadata(threadId);

    logger.info('gmail.thread.complete', {
      userId: user.id,
      requestId,
      threadId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(thread, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'gmail.thread.failed',
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
