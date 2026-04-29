import { describe, expect, it, vi } from 'vitest';
import type { ClassifiedThread } from '@/lib/claude/parser';
import { ExternalApiError } from '@/lib/errors';
import { executeClassification, type ExecutorContext, type ExecutorThresholds } from './executor';

const THRESHOLDS: ExecutorThresholds = { autoExecute: 0.9, queue: 0.7 };

function classified(overrides: Partial<ClassifiedThread> = {}): ClassifiedThread {
  return {
    threadId: '18c7d5f2a1b3c4d5',
    bucket: 'Newsletter',
    confidence: 0.96,
    recommendedAction: 'archive',
    reasoning: 'Substack digest from a known sender, no action required.',
    ...overrides,
  };
}

type CtxFns = Pick<
  ExecutorContext,
  | 'insertClassification'
  | 'markClassificationExecuted'
  | 'insertReviewQueue'
  | 'setThreadStatus'
  | 'archiveGmail'
  | 'addGmailLabel'
>;

type SpyMap = { [K in keyof CtxFns]: ReturnType<typeof vi.fn<CtxFns[K]>> };

interface CtxOverrides {
  archiveGmail?: SpyMap['archiveGmail'];
  addGmailLabel?: SpyMap['addGmailLabel'];
}

function buildCtx(overrides: CtxOverrides = {}): ExecutorContext & { spies: SpyMap } {
  const insertClassification = vi
    .fn<CtxFns['insertClassification']>()
    .mockResolvedValue('class_id_1');
  const markClassificationExecuted = vi
    .fn<CtxFns['markClassificationExecuted']>()
    .mockResolvedValue(undefined);
  const insertReviewQueue = vi.fn<CtxFns['insertReviewQueue']>().mockResolvedValue(undefined);
  const setThreadStatus = vi.fn<CtxFns['setThreadStatus']>().mockResolvedValue(undefined);
  const archiveGmail =
    overrides.archiveGmail ?? vi.fn<CtxFns['archiveGmail']>().mockResolvedValue(undefined);
  const addGmailLabel =
    overrides.addGmailLabel ?? vi.fn<CtxFns['addGmailLabel']>().mockResolvedValue(undefined);
  return {
    userId: 'user_1',
    dbThreadId: 'db_thread_1',
    bucketId: 'bucket_1',
    insertClassification,
    markClassificationExecuted,
    insertReviewQueue,
    setThreadStatus,
    archiveGmail,
    addGmailLabel,
    spies: {
      insertClassification,
      markClassificationExecuted,
      insertReviewQueue,
      setThreadStatus,
      archiveGmail,
      addGmailLabel,
    },
  };
}

describe('executeClassification', () => {
  it('auto-executes archive at confidence ≥ autoExecute threshold', async () => {
    const ctx = buildCtx();
    const result = await executeClassification(
      classified({ confidence: 0.95, recommendedAction: 'archive', bucket: 'Auto-Archive' }),
      THRESHOLDS,
      ctx,
    );

    expect(result).toEqual({ status: 'auto_executed', threadId: '18c7d5f2a1b3c4d5' });
    expect(ctx.spies.archiveGmail).toHaveBeenCalledWith('18c7d5f2a1b3c4d5');
    expect(ctx.spies.addGmailLabel).not.toHaveBeenCalled();
    expect(ctx.spies.markClassificationExecuted).toHaveBeenCalledWith('class_id_1', 'archive');
    expect(ctx.spies.setThreadStatus).toHaveBeenCalledWith('db_thread_1', 'executed');
    expect(ctx.spies.insertReviewQueue).not.toHaveBeenCalled();
  });

  it('auto-executes label at confidence ≥ autoExecute threshold', async () => {
    const ctx = buildCtx();
    const result = await executeClassification(
      classified({ confidence: 0.92, recommendedAction: 'label', bucket: 'Important' }),
      THRESHOLDS,
      ctx,
    );

    expect(result.status).toBe('auto_executed');
    expect(ctx.spies.addGmailLabel).toHaveBeenCalledWith('18c7d5f2a1b3c4d5', 'Important');
    expect(ctx.spies.archiveGmail).not.toHaveBeenCalled();
    expect(ctx.spies.markClassificationExecuted).toHaveBeenCalledWith('class_id_1', 'label');
  });

  it('queues mid-confidence (≥ queue, < autoExecute) classifications', async () => {
    const ctx = buildCtx();
    const result = await executeClassification(
      classified({ confidence: 0.8, recommendedAction: 'label', bucket: 'Can Wait' }),
      THRESHOLDS,
      ctx,
    );

    expect(result).toEqual({ status: 'queued', threadId: '18c7d5f2a1b3c4d5' });
    expect(ctx.spies.insertReviewQueue).toHaveBeenCalledWith('class_id_1', 'user_1');
    expect(ctx.spies.setThreadStatus).toHaveBeenCalledWith('db_thread_1', 'queued');
    expect(ctx.spies.archiveGmail).not.toHaveBeenCalled();
    expect(ctx.spies.addGmailLabel).not.toHaveBeenCalled();
  });

  it('bucket-only at confidence < queue threshold (no action, no queue)', async () => {
    const ctx = buildCtx();
    const result = await executeClassification(
      classified({ confidence: 0.5, recommendedAction: 'none', bucket: 'Newsletter' }),
      THRESHOLDS,
      ctx,
    );

    expect(result).toEqual({ status: 'bucketed', threadId: '18c7d5f2a1b3c4d5' });
    expect(ctx.spies.setThreadStatus).toHaveBeenCalledWith('db_thread_1', 'classified');
    expect(ctx.spies.archiveGmail).not.toHaveBeenCalled();
    expect(ctx.spies.addGmailLabel).not.toHaveBeenCalled();
    expect(ctx.spies.insertReviewQueue).not.toHaveBeenCalled();
    expect(ctx.spies.markClassificationExecuted).not.toHaveBeenCalled();
  });

  it('degrades to queued when Gmail fails during auto-execute (no throw)', async () => {
    const archiveGmail = vi.fn().mockRejectedValue(new ExternalApiError('gmail', 'archive failed'));
    const ctx = buildCtx({ archiveGmail });

    const result = await executeClassification(
      classified({ confidence: 0.97, recommendedAction: 'archive' }),
      THRESHOLDS,
      ctx,
    );

    expect(result).toEqual({ status: 'queued', threadId: '18c7d5f2a1b3c4d5' });
    expect(archiveGmail).toHaveBeenCalledTimes(1);
    expect(ctx.spies.markClassificationExecuted).not.toHaveBeenCalled();
    expect(ctx.spies.insertReviewQueue).toHaveBeenCalledWith('class_id_1', 'user_1');
    expect(ctx.spies.setThreadStatus).toHaveBeenCalledWith('db_thread_1', 'queued');
  });

  it('normalizes keep_inbox to none at low confidence (bucket-only, no Gmail)', async () => {
    const ctx = buildCtx();
    const result = await executeClassification(
      classified({ confidence: 0.65, recommendedAction: 'keep_inbox', bucket: 'Important' }),
      THRESHOLDS,
      ctx,
    );

    expect(result.status).toBe('bucketed');
    expect(ctx.spies.insertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ recommendedAction: 'none' }),
    );
    expect(ctx.spies.archiveGmail).not.toHaveBeenCalled();
    expect(ctx.spies.addGmailLabel).not.toHaveBeenCalled();
  });

  it('high-confidence keep_inbox does not fire a Gmail action (bucket-only)', async () => {
    // keep_inbox normalizes to none — even at 0.99 confidence, the executor
    // must not archive or label. Verifies the explicit guard in the auto-
    // execute branch.
    const ctx = buildCtx();
    const result = await executeClassification(
      classified({ confidence: 0.99, recommendedAction: 'keep_inbox', bucket: 'Important' }),
      THRESHOLDS,
      ctx,
    );

    expect(result.status).toBe('bucketed');
    expect(ctx.spies.archiveGmail).not.toHaveBeenCalled();
    expect(ctx.spies.addGmailLabel).not.toHaveBeenCalled();
    expect(ctx.spies.setThreadStatus).toHaveBeenCalledWith('db_thread_1', 'classified');
  });
});
