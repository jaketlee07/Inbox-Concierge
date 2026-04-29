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
export async function runBatches(
  threads: readonly GmailThread[],
  buckets: readonly string[],
  userOverridesSummary: string,
): Promise<BatchResult[]> {
  if (threads.length === 0) return [];
  const chunks = chunk(threads, BATCH_SIZE);
  const limit = pLimit(CONCURRENCY);
  return Promise.all(
    chunks.map((threadChunk) =>
      limit(() => runOneBatch(threadChunk, buckets, userOverridesSummary)),
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
