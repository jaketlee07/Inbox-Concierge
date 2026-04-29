import 'server-only';
import type { ClassifiedThread } from '@/lib/claude/parser';
import { logger } from '@/lib/logger';
import { isAppError } from '@/lib/errors';

export interface ExecutorThresholds {
  autoExecute: number;
  queue: number;
}

// DB enum for classifications.recommended_action — `keep_inbox` is a valid
// model output but not a valid DB value; the executor normalizes it to
// `none` (semantically: "leave it alone, no action").
export type DbAction = 'archive' | 'label' | 'none';

// Dep-injected operations. The route in Phase 4.7 composes these from a real
// SupabaseClient + GmailClient; tests pass `vi.fn()` mocks. This shape keeps
// the executor's branching logic testable without chain-mocking Supabase.
export interface ExecutorContext {
  userId: string;
  dbThreadId: string;
  bucketId: string;
  insertClassification: (input: {
    userId: string;
    dbThreadId: string;
    bucketId: string;
    confidence: number;
    recommendedAction: DbAction;
  }) => Promise<string>;
  markClassificationExecuted: (classificationId: string, action: DbAction) => Promise<void>;
  insertReviewQueue: (classificationId: string, userId: string) => Promise<void>;
  setThreadStatus: (
    dbThreadId: string,
    status: 'classified' | 'executed' | 'queued',
  ) => Promise<void>;
  archiveGmail: (gmailThreadId: string) => Promise<void>;
  addGmailLabel: (gmailThreadId: string, label: string) => Promise<void>;
}

export type ExecutionResult =
  | { status: 'auto_executed'; threadId: string }
  | { status: 'queued'; threadId: string }
  | { status: 'bucketed'; threadId: string };

export async function executeClassification(
  classified: ClassifiedThread,
  thresholds: ExecutorThresholds,
  ctx: ExecutorContext,
): Promise<ExecutionResult> {
  const dbAction: DbAction =
    classified.recommendedAction === 'keep_inbox' ? 'none' : classified.recommendedAction;

  const classificationId = await ctx.insertClassification({
    userId: ctx.userId,
    dbThreadId: ctx.dbThreadId,
    bucketId: ctx.bucketId,
    confidence: classified.confidence,
    recommendedAction: dbAction,
  });

  // High-confidence branch.
  if (classified.confidence >= thresholds.autoExecute) {
    if (dbAction === 'archive' || dbAction === 'label') {
      // Auto-execute: actionable recommendation, model is confident, do it.
      try {
        if (dbAction === 'archive') {
          await ctx.archiveGmail(classified.threadId);
        } else {
          await ctx.addGmailLabel(classified.threadId, classified.bucket);
        }
        await ctx.markClassificationExecuted(classificationId, dbAction);
        await ctx.setThreadStatus(ctx.dbThreadId, 'executed');
        logger.info('executor.auto_executed', {
          threadId: classified.threadId,
          bucket: classified.bucket,
          confidence: classified.confidence,
          action: dbAction,
        });
        return { status: 'auto_executed', threadId: classified.threadId };
      } catch (err) {
        // Phase 4.9 spec: Gmail API failure during auto-execute degrades to
        // queued — log it, don't throw, push to review queue so the user can
        // retry manually.
        logger.warn('executor.gmail_failed_degrade_to_queued', {
          threadId: classified.threadId,
          errorCode: isAppError(err) ? err.code : 'UNKNOWN',
        });
        await ctx.insertReviewQueue(classificationId, ctx.userId);
        await ctx.setThreadStatus(ctx.dbThreadId, 'queued');
        return { status: 'queued', threadId: classified.threadId };
      }
    }
    // High-confidence 'none' (incl. normalized keep_inbox): model is sure
    // no action is needed. Don't queue (nothing to review), just bucket.
    await ctx.setThreadStatus(ctx.dbThreadId, 'classified');
    logger.info('executor.bucketed', {
      threadId: classified.threadId,
      bucket: classified.bucket,
      confidence: classified.confidence,
      action: dbAction,
    });
    return { status: 'bucketed', threadId: classified.threadId };
  }

  // Queue branch: mid-confidence, push to review queue.
  if (classified.confidence >= thresholds.queue) {
    await ctx.insertReviewQueue(classificationId, ctx.userId);
    await ctx.setThreadStatus(ctx.dbThreadId, 'queued');
    logger.info('executor.queued', {
      threadId: classified.threadId,
      bucket: classified.bucket,
      confidence: classified.confidence,
      action: dbAction,
    });
    return { status: 'queued', threadId: classified.threadId };
  }

  // Bucket-only branch: low confidence, no action, just record the bucket.
  await ctx.setThreadStatus(ctx.dbThreadId, 'classified');
  logger.info('executor.bucketed', {
    threadId: classified.threadId,
    bucket: classified.bucket,
    confidence: classified.confidence,
    action: dbAction,
  });
  return { status: 'bucketed', threadId: classified.threadId };
}
