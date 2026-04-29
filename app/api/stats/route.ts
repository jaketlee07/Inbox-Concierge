import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { appReadLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AuthError, isAppError, toErrorResponse } from '@/lib/errors';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthError();

    const limit = await appReadLimiter.limit(user.id);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      logger.warn('stats.read.rate_limited', { userId: user.id, requestId });
      return NextResponse.json(
        { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
        {
          status: 429,
          headers: { 'x-request-id': requestId, 'Retry-After': String(retryAfter) },
        },
      );
    }

    const todayStartIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [autoHandled, queued, overrides] = await Promise.all([
      supabase
        .from('classifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('executed_at', todayStartIso),
      supabase
        .from('review_queue')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'pending'),
      supabase
        .from('overrides')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', weekAgoIso),
    ]);

    if (autoHandled.error || queued.error || overrides.error) {
      logger.error('stats.read.read_failed', {
        userId: user.id,
        requestId,
      });
      return NextResponse.json(
        { error: { code: 'DB_READ_FAILED', message: 'Failed to load stats' } },
        { status: 500, headers: { 'x-request-id': requestId } },
      );
    }

    logger.info('stats.read.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        autoHandledToday: autoHandled.count ?? 0,
        queuedForReview: queued.count ?? 0,
        overridesThisWeek: overrides.count ?? 0,
      },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    logger.error(
      'stats.read.failed',
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
