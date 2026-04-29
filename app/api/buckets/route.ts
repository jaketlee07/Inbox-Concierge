import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { gmailFetchLimiter, queueMutationLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AppError, AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';

type DefaultAction = 'archive' | 'label' | null;

interface BucketView {
  id: string;
  name: string;
  description: string;
  color: string;
  defaultAction: DefaultAction;
  sortOrder: number;
  isSystem: boolean;
  threadCount: number;
}

interface BucketRow {
  id: string;
  name: string;
  description: string;
  color: string;
  default_action: DefaultAction;
  sort_order: number;
  is_system: boolean;
}

const COLOR_PALETTE = ['#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#14b8a6'] as const;

const CreateBodySchema = z.object({
  name: z.string().trim().min(1).max(32),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthError();

    const limit = await gmailFetchLimiter.limit(user.id);
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

    const [bucketsRes, classificationsRes] = await Promise.all([
      supabase
        .from('buckets')
        .select('id, name, description, color, default_action, sort_order, is_system')
        .eq('user_id', user.id)
        .order('sort_order'),
      supabase.from('classifications').select('bucket_id').eq('user_id', user.id),
    ]);

    if (bucketsRes.error || classificationsRes.error) {
      throw new AppError(
        'DB_READ_FAILED',
        'Failed to load buckets',
        500,
        bucketsRes.error ?? classificationsRes.error,
      );
    }

    const counts = new Map<string, number>();
    for (const c of classificationsRes.data ?? []) {
      const key = (c as { bucket_id: string }).bucket_id;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const buckets: BucketView[] = (bucketsRes.data as BucketRow[]).map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      color: b.color,
      defaultAction: b.default_action,
      sortOrder: b.sort_order,
      isSystem: b.is_system,
      threadCount: counts.get(b.id) ?? 0,
    }));

    logger.info('buckets.list.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ buckets }, { headers: { 'x-request-id': requestId } });
  } catch (err) {
    logger.error(
      'buckets.list.failed',
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
      return NextResponse.json(
        { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
        {
          status: 429,
          headers: { 'x-request-id': requestId, 'Retry-After': String(retryAfter) },
        },
      );
    }

    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsed = CreateBodySchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError('Invalid request body');
    const name = parsed.data.name;

    const { data: existing, error: existingErr } = await supabase
      .from('buckets')
      .select('id, name, color, sort_order')
      .eq('user_id', user.id);
    if (existingErr) {
      throw new AppError('DB_READ_FAILED', 'Failed to load buckets', 500, existingErr);
    }

    if ((existing ?? []).some((b) => (b as { name: string }).name === name)) {
      return NextResponse.json(
        { error: { code: 'BUCKET_EXISTS', message: `Bucket "${name}" already exists` } },
        { status: 409, headers: { 'x-request-id': requestId } },
      );
    }

    const usedColors = new Set((existing ?? []).map((b) => (b as { color: string }).color));
    const color = COLOR_PALETTE.find((c) => !usedColors.has(c)) ?? COLOR_PALETTE[0];

    const maxSort = (existing ?? []).reduce(
      (m, b) => Math.max(m, (b as { sort_order: number }).sort_order),
      0,
    );

    const { data: inserted, error: insertErr } = await supabase
      .from('buckets')
      .insert({
        user_id: user.id,
        name,
        description: `Threads about ${name}`,
        color,
        default_action: null,
        sort_order: maxSort + 1,
        is_system: false,
      })
      .select('id, name, description, color, default_action, sort_order, is_system')
      .single();
    if (insertErr || !inserted) {
      throw new AppError('DB_INSERT_FAILED', 'Failed to create bucket', 500, insertErr);
    }

    const row = inserted as BucketRow;
    const view: BucketView = {
      id: row.id,
      name: row.name,
      description: row.description,
      color: row.color,
      defaultAction: row.default_action,
      sortOrder: row.sort_order,
      isSystem: row.is_system,
      threadCount: 0,
    };

    logger.info('buckets.create.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { bucket: view },
      { status: 201, headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    logger.error(
      'buckets.create.failed',
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
