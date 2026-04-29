import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GmailClient } from '@/lib/gmail/client';
import { gmailFetchLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { createClient } from '@/lib/supabase/server';
import { AppError, AuthError, ValidationError, isAppError, toErrorResponse } from '@/lib/errors';
import type { GmailThread } from '@/types/thread';

type DbStatus = 'pending' | 'classified' | 'executed' | 'queued' | 'error';
type DbAction = 'archive' | 'label' | 'none';
type ViewStatus = 'auto_executed' | 'queued' | 'bucketed';

interface ClassificationView {
  bucket: string;
  confidence: number;
  recommendedAction: DbAction;
  reasoning: string;
  status: ViewStatus;
}

interface ClassificationRow {
  confidence: number | string;
  recommended_action: DbAction;
  threads: { gmail_thread_id: string; classification_status: DbStatus };
  buckets: { name: string };
}

const BodySchema = z.object({
  maxResults: z.number().int().min(1).max(200).optional(),
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

    const limit = await gmailFetchLimiter.limit(user.id);
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      logger.warn('gmail.fetch_threads.rate_limited', { userId: user.id, requestId });
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
    const maxResults = parsed.data.maxResults ?? 200;

    logger.info('gmail.fetch_threads.start', { userId: user.id, requestId });

    const client = new GmailClient(user.id);
    const ids = await client.listThreadIds(maxResults);

    if (ids.length === 0) {
      logger.info('gmail.fetch_threads.complete', {
        userId: user.id,
        requestId,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { count: 0, fetched: 0, threads: [], failed: [] },
        { headers: { 'x-request-id': requestId } },
      );
    }

    const settled = await Promise.allSettled(ids.map((id) => client.getThreadMetadata(id)));

    const threads: GmailThread[] = [];
    const failed: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const threadId = ids[i];
      if (r.status === 'fulfilled') {
        // Defensive: latest_date is NOT NULL in schema. A thread with empty
        // latestDate would fail the upsert and poison the batch — drop it.
        if (r.value.latestDate === '') {
          failed.push(threadId);
          logger.warn('gmail.fetch_threads.thread_failed', {
            userId: user.id,
            requestId,
            threadId,
            errorCode: 'MISSING_DATE',
          });
        } else {
          threads.push(r.value);
        }
      } else {
        failed.push(threadId);
        logger.warn('gmail.fetch_threads.thread_failed', {
          userId: user.id,
          requestId,
          threadId,
          errorCode: isAppError(r.reason) ? r.reason.code : 'UNKNOWN',
        });
      }
    }

    if (threads.length > 0) {
      const rows = threads.map((t) => ({
        user_id: user.id,
        gmail_thread_id: t.id,
        sender_domain: t.latestSenderDomain ?? null,
        latest_date: t.latestDate,
        is_unread: t.isUnread,
        has_attachments: t.hasAttachments,
        gmail_label_ids: t.labelIds,
        message_count: t.messageCount,
      }));
      const { error: upsertErr } = await supabase
        .from('threads')
        .upsert(rows, { onConflict: 'user_id,gmail_thread_id' });
      if (upsertErr) {
        logger.error(
          'gmail.fetch_threads.upsert_failed',
          { userId: user.id, requestId },
          upsertErr,
        );
        throw new AppError('DB_UPSERT_FAILED', 'Failed to persist threads', 500, upsertErr);
      }
    }

    // Rehydrate persisted classifications so reload preserves bucket assignments.
    // Reasoning is intentionally never persisted (privacy invariant) — return empty.
    const classifications = await readClassifications(supabase, user.id, threads);

    logger.info('gmail.fetch_threads.complete', {
      userId: user.id,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { count: ids.length, fetched: threads.length, threads, failed, classifications },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    logger.error(
      'gmail.fetch_threads.failed',
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

async function readClassifications(
  supabase: SupabaseClient,
  userId: string,
  threads: GmailThread[],
): Promise<Record<string, ClassificationView>> {
  const out: Record<string, ClassificationView> = {};
  if (threads.length === 0) return out;
  const fetchedIds = new Set(threads.map((t) => t.id));

  const { data, error } = await supabase
    .from('classifications')
    .select(
      `confidence, recommended_action, threads!inner(gmail_thread_id, classification_status), buckets!inner(name)`,
    )
    .eq('user_id', userId);

  if (error) {
    logger.warn('gmail.fetch_threads.classifications_read_failed', {
      userId,
      errorCode: error.code,
    });
    return out;
  }

  for (const row of (data ?? []) as unknown as ClassificationRow[]) {
    const gid = row.threads.gmail_thread_id;
    if (!fetchedIds.has(gid)) continue;
    out[gid] = {
      bucket: row.buckets.name,
      confidence: Number(row.confidence),
      recommendedAction: row.recommended_action,
      reasoning: '',
      status: deriveStatus(row.threads.classification_status),
    };
  }
  return out;
}

function deriveStatus(s: DbStatus): ViewStatus {
  if (s === 'executed') return 'auto_executed';
  if (s === 'queued') return 'queued';
  return 'bucketed';
}
