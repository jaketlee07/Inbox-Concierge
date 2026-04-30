// Server-only Anthropic SDK wrapper for batch thread classification.
//
// Concurrency is owned by the batch orchestrator (lib/pipeline/batch.ts,
// Phase 4.4) via pLimit(5). This module deliberately does NOT include a
// module-level limiter — diverging from lib/gmail/client.ts (which has one
// because cross-caller Gmail routes share Google's per-user quota). Here,
// only the orchestrator calls Claude, so keeping concurrency at the call
// site is correct.

import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { ExternalApiError, isAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { GmailThread } from '@/types/thread';
import {
  CLASSIFY_THREADS_SYSTEM_PROMPT,
  buildClassifyUserPayload,
  type ClassifyUserPayload,
} from './prompts';

const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 30_000;
// Worst-case per-batch latency: 3 attempts × 30s timeout + (1s + 2s) backoff
// = ~93s. The orchestrator's overall budget must accommodate this.
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const TOOL_NAME = 'classify_threads';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// JSON Schema for the tool input. `bucket` is `string` (not enum) so the tool
// definition stays byte-stable across users with different bucket lists,
// which keeps it eligible for prompt caching. The bucket-validity check is
// the parser's job (Phase 4.3). Anthropic's input_schema requires the root
// to be type:'object', so a top-level array isn't an option.
const classifyTool: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    'Return classifications for every thread in the input batch. Each thread_id from the input must appear exactly once in classifications.',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            thread_id: { type: 'string' },
            bucket: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            recommended_action: {
              type: 'string',
              enum: ['archive', 'label', 'keep_inbox', 'none'],
            },
            reasoning: { type: 'string', minLength: 1, maxLength: 120 },
          },
          required: ['thread_id', 'bucket', 'confidence', 'recommended_action', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
    required: ['classifications'],
    additionalProperties: false,
  },
};

export interface ClaudeClassification {
  thread_id: string;
  bucket: string;
  confidence: number;
  recommended_action: 'archive' | 'label' | 'keep_inbox' | 'none';
  reasoning: string;
}

export interface ClaudeClassifyBatchResult {
  classifications: ClaudeClassification[];
}

export async function classifyBatch(
  threads: readonly GmailThread[],
  buckets: readonly { name: string; description: string }[],
  userOverridesSummary: string,
): Promise<ClaudeClassifyBatchResult> {
  const userPayload = buildClassifyUserPayload(threads, buckets, userOverridesSummary);
  return withRetry(() => callClaude(userPayload));
}

async function callClaude(userPayload: ClassifyUserPayload): Promise<ClaudeClassifyBatchResult> {
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: CLASSIFY_THREADS_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [classifyTool],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
    },
    { timeout: TIMEOUT_MS },
  );
  const input = extractToolInput(response);
  // Cast at the seam: the parser (Phase 4.3) owns runtime validation
  // (3-layer Zod check). The TS interface is documentation, not a guarantee.
  return input as ClaudeClassifyBatchResult;
}

function extractToolInput(response: Anthropic.Message): unknown {
  if (response.stop_reason === 'max_tokens') {
    throw new ExternalApiError('claude', 'response truncated at max_tokens');
  }
  if (response.stop_reason !== 'tool_use') {
    throw new ExternalApiError(
      'claude',
      `unexpected stop_reason: ${response.stop_reason ?? 'null'}`,
    );
  }
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!block) {
    throw new ExternalApiError('claude', 'no tool_use block in response');
  }
  if (block.name !== TOOL_NAME) {
    throw new ExternalApiError('claude', 'unexpected tool name in response');
  }
  return block.input;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await fn();
      logger.info('claude.classify.success', {
        attempt,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      lastErr = err;
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      if (!isRetryable(err) || attempt === 3) {
        const wrapped = classifyError(err);
        logger.error('claude.classify.failed', {
          attempt,
          statusCode: status,
          errorCode: isAppError(wrapped) ? wrapped.code : 'UNKNOWN',
        });
        throw wrapped;
      }
      logger.warn('claude.classify.retry', {
        attempt,
        statusCode: status,
      });
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  // Unreachable — the loop either returns or throws on attempt 3.
  throw classifyError(lastErr);
}

function isRetryable(err: unknown): boolean {
  // APIConnectionError must be checked first: it extends APIError with
  // status === undefined, so the generic 5xx check below would skip it.
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIError) {
    return typeof err.status === 'number' && err.status >= 500 && err.status < 600;
  }
  return false;
}

function classifyError(err: unknown): Error {
  if (isAppError(err)) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new ExternalApiError('claude', 'authentication failed', err);
  }
  return new ExternalApiError('claude', 'classify failed', err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
