import 'server-only';
import pLimit from 'p-limit';
import { classifyBatch } from '@/lib/claude/client';
import { parseClassifyResult, type ClassifiedThread } from '@/lib/claude/parser';
import { logger } from '@/lib/logger';
import { isAppError } from '@/lib/errors';
import type { GmailThread } from '@/types/thread';

const BATCH_SIZE = 20;
const CONCURRENCY = 5;

export type BatchResult =
  | {
      status: 'success';
      threadIds: string[];
      classifications: ClassifiedThread[];
    }
  | {
      status: 'failed';
      threadIds: string[];
      errorCode: string;
      errorMessage: string;
    };

// Chunks `threads` into batches of 20, runs them through Claude with pLimit(5)
// concurrency, and returns one BatchResult per chunk. Per-batch error isolation
// is the whole point: a single bad batch never throws — it returns
// `{status:'failed', ...}` so the other 9 (of 10 typical) keep going.
//
// Optional `onBatchComplete` runs INSIDE the pLimit wrapper so DB/Gmail work
// the caller does in the callback counts toward the same 5-batch budget —
// keeps Postgres from getting hammered while Claude calls are also in flight.
// Callback errors are caught and logged so a flaky callback can't poison
// sibling batches.
export async function runBatches(
  threads: readonly GmailThread[],
  buckets: readonly string[],
  userOverridesSummary: string,
  onBatchComplete?: (result: BatchResult) => Promise<void>,
): Promise<BatchResult[]> {
  if (threads.length === 0) return [];
  const chunks = chunk(threads, BATCH_SIZE);
  const limit = pLimit(CONCURRENCY);
  return Promise.all(
    chunks.map((threadChunk) =>
      limit(async () => {
        const result = await runOneBatch(threadChunk, buckets, userOverridesSummary);
        if (onBatchComplete) {
          try {
            await onBatchComplete(result);
          } catch (err) {
            logger.error('batch.callback_failed', {
              errorCode: isAppError(err) ? err.code : 'UNKNOWN',
            });
          }
        }
        return result;
      }),
    ),
  );
}

async function runOneBatch(
  threads: readonly GmailThread[],
  buckets: readonly string[],
  userOverridesSummary: string,
): Promise<BatchResult> {
  const threadIds = threads.map((t) => t.id);
  const start = Date.now();
  try {
    const raw = await classifyBatch(threads, buckets, userOverridesSummary);
    const classifications = parseClassifyResult(raw, threadIds, buckets);
    logger.info('batch.success', {
      durationMs: Date.now() - start,
    });
    return { status: 'success', threadIds, classifications };
  } catch (err) {
    const errorCode = isAppError(err) ? err.code : 'UNKNOWN';
    const errorMessage = err instanceof Error ? err.message : 'classification failed';
    logger.error('batch.failed', {
      durationMs: Date.now() - start,
      errorCode,
    });
    return { status: 'failed', threadIds, errorCode, errorMessage };
  }
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
