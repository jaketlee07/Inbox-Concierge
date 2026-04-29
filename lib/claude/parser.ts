import { z } from 'zod';
import { ClassificationError } from '@/lib/errors';

// Wire shape from prompts.ts (snake_case). The parser owns runtime validation
// for what client.ts surfaced as `unknown` from the SDK — the deliberate seam
// where the `as ClaudeClassifyBatchResult` cast becomes truth.
const ItemSchema = z.object({
  thread_id: z.string().min(1),
  bucket: z.string().min(1),
  confidence: z.number().min(0).max(1),
  recommended_action: z.enum(['archive', 'label', 'keep_inbox', 'none']),
  reasoning: z.string().max(120),
});

const ResultSchema = z.object({
  classifications: z.array(ItemSchema),
});

export interface ClassifiedThread {
  threadId: string;
  bucket: string;
  confidence: number;
  recommendedAction: 'archive' | 'label' | 'keep_inbox' | 'none';
  reasoning: string;
}

export function parseClassifyResult(
  raw: unknown,
  inputThreadIds: readonly string[],
  validBuckets: readonly string[],
): ClassifiedThread[] {
  // Layer 1: JSON shape.
  const parsed = ResultSchema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ClassificationError(`Invalid response shape: ${summary}`, parsed.error.issues);
  }
  const items = parsed.data.classifications;

  // Layer 3 (run before coverage): bucket validity. An invalid bucket should
  // throw even on a hallucinated thread_id — running this first makes the
  // error deterministic regardless of which row carries the bad bucket.
  const validBucketSet = new Set(validBuckets);
  for (const item of items) {
    if (!validBucketSet.has(item.bucket)) {
      throw new ClassificationError(`Invalid bucket: ${item.bucket}`);
    }
  }

  // Layer 2: thread coverage. Hallucinated extras are filtered; duplicates
  // and missing inputs throw.
  const inputIdSet = new Set(inputThreadIds);
  const seenIds = new Set<string>();
  const filtered: z.infer<typeof ItemSchema>[] = [];
  for (const item of items) {
    if (!inputIdSet.has(item.thread_id)) continue;
    if (seenIds.has(item.thread_id)) {
      throw new ClassificationError(`Duplicate classification: ${item.thread_id}`);
    }
    seenIds.add(item.thread_id);
    filtered.push(item);
  }
  for (const id of inputThreadIds) {
    if (!seenIds.has(id)) {
      throw new ClassificationError(`Missing classification: ${id}`);
    }
  }

  return filtered.map((i) => ({
    threadId: i.thread_id,
    bucket: i.bucket,
    confidence: i.confidence,
    recommendedAction: i.recommended_action,
    reasoning: i.reasoning,
  }));
}
