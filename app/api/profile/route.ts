import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { appReadLimiter, queueMutationLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AppError, AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';

const PatchSchema = z
  .object({
    autoExecuteThreshold: z.number().min(0.7).max(0.99).optional(),
    reviewThreshold: z.number().min(0.5).max(0.89).optional(),
    autopilotPaused: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.autoExecuteThreshold === undefined ||
      d.reviewThreshold === undefined ||
      d.reviewThreshold < d.autoExecuteThreshold,
    { message: 'reviewThreshold must be less than autoExecuteThreshold' },
  );

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
      return NextResponse.json(
        { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
        {
          status: 429,
          headers: { 'x-request-id': requestId, 'Retry-After': String(retryAfter) },
        },
      );
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('auto_execute_threshold, review_threshold, autopilot_paused')
      .eq('id', user.id)
      .single();
    if (error || !data) {
      throw new AppError('DB_READ_FAILED', 'Failed to load profile', 500, error);
    }

    logger.info('profile.read.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        autoExecuteThreshold: Number(data.auto_execute_threshold),
        reviewThreshold: Number(data.review_threshold),
        autopilotPaused: data.autopilot_paused,
      },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    logger.error(
      'profile.read.failed',
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

export async function PATCH(request: NextRequest): Promise<NextResponse> {
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
      return NextResponse.json(
        { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
        {
          status: 429,
          headers: { 'x-request-id': requestId, 'Retry-After': String(retryAfter) },
        },
      );
    }

    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsed = PatchSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }

    const update: Record<string, number | boolean> = {};
    if (parsed.data.autoExecuteThreshold !== undefined) {
      update.auto_execute_threshold = parsed.data.autoExecuteThreshold;
    }
    if (parsed.data.reviewThreshold !== undefined) {
      update.review_threshold = parsed.data.reviewThreshold;
    }
    if (parsed.data.autopilotPaused !== undefined) {
      update.autopilot_paused = parsed.data.autopilotPaused;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ ok: true }, { headers: { 'x-request-id': requestId } });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(update)
      .eq('id', user.id)
      .select('auto_execute_threshold, review_threshold, autopilot_paused')
      .single();
    if (error || !data) {
      throw new AppError('DB_UPDATE_FAILED', 'Failed to update profile', 500, error);
    }

    logger.info('profile.update.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        autoExecuteThreshold: Number(data.auto_execute_threshold),
        reviewThreshold: Number(data.review_threshold),
        autopilotPaused: data.autopilot_paused,
      },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    logger.error(
      'profile.update.failed',
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
