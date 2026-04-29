import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GmailClient } from '@/lib/gmail/client';
import { gmailMutationLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';

const BodySchema = z.object({
  threadId: z.string().min(1),
  body: z.string().min(1).max(10_000),
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
      logger.warn('gmail.draft.rate_limited', { userId: user.id, requestId });
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
    const { threadId, body } = parsed.data;

    logger.info('gmail.draft.start', { userId: user.id, requestId, threadId });

    const client = new GmailClient(user.id);
    const { draftId } = await client.createDraft(threadId, body);

    logger.info('gmail.draft.complete', {
      userId: user.id,
      requestId,
      threadId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ draftId }, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'gmail.draft.failed',
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
