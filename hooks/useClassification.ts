'use client';

// Consumer for the /api/classify SSE stream. EventSource doesn't support POST,
// so we use fetch + ReadableStream and parse SSE frames by hand.
//
// As `batch_complete` events arrive we merge classifications into the threads
// query cache via `queryClient.setQueryData(['threads', userId], ...)` so the
// inbox UI re-renders with bucket badges + executor status without a refetch.
// Progress / completion / errors are exposed as React state.

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FetchThreadsResponse, ThreadClassificationView } from '@/hooks/useThreads';

export interface ClassificationProgress {
  classified: number;
  total: number;
  autoExecuted: number;
  queued: number;
}

export interface ClassificationSummary {
  autoExecuted: number;
  queued: number;
  bucketed: number;
  failed: number;
}

export interface UseClassificationResult {
  start: (force?: boolean) => Promise<void>;
  isRunning: boolean;
  progress: ClassificationProgress | null;
  complete: ClassificationSummary | null;
  error: Error | null;
}

interface ExecutorResultPayload {
  threadId: string;
  bucket: string;
  confidence: number;
  recommendedAction: ThreadClassificationView['recommendedAction'];
  reasoning: string;
  status: ThreadClassificationView['status'];
}

export function useClassification(userId: string): UseClassificationResult {
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<ClassificationProgress | null>(null);
  const [complete, setComplete] = useState<ClassificationSummary | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const mergeClassifications = useCallback(
    (entries: ExecutorResultPayload[]) => {
      queryClient.setQueryData<FetchThreadsResponse | undefined>(['threads', userId], (prev) => {
        if (!prev) return prev;
        const next = { ...(prev.classifications ?? {}) };
        for (const e of entries) {
          next[e.threadId] = {
            bucket: e.bucket,
            confidence: e.confidence,
            recommendedAction: e.recommendedAction,
            reasoning: e.reasoning,
            status: e.status,
          };
        }
        return { ...prev, classifications: next };
      });
    },
    [queryClient, userId],
  );

  const start = useCallback(
    async (force = false): Promise<void> => {
      // A second start() call cancels the first. The server's in-flight
      // batches keep going (they're not tied to this fetch's signal) — only
      // the SSE consumption stops on this end.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsRunning(true);
      setProgress(null);
      setComplete(null);
      setError(null);

      let classified = 0;
      let total = 0;
      let autoExecuted = 0;
      let queued = 0;

      try {
        const res = await fetch('/api/classify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string };
          };
          throw new Error(body.error?.message ?? `Request failed (${res.status})`);
        }
        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const parsed = parseFrame(frame);
            if (!parsed) continue;
            const { event, data } = parsed;

            if (event === 'pipeline_started') {
              const payload = data as { total: number };
              total = payload.total;
              setProgress({ classified: 0, total, autoExecuted: 0, queued: 0 });
            } else if (event === 'batch_complete') {
              const payload = data as {
                threadIds: string[];
                executionResults: ExecutorResultPayload[];
              };
              for (const r of payload.executionResults) {
                classified += 1;
                if (r.status === 'auto_executed') autoExecuted += 1;
                else if (r.status === 'queued') queued += 1;
              }
              mergeClassifications(payload.executionResults);
              setProgress({ classified, total, autoExecuted, queued });
            } else if (event === 'batch_failed') {
              const payload = data as { threadIds: string[] };
              classified += payload.threadIds.length;
              setProgress({ classified, total, autoExecuted, queued });
            } else if (event === 'pipeline_complete') {
              setComplete(data as ClassificationSummary);
            } else if (event === 'pipeline_error') {
              const payload = data as { errorCode: string };
              throw new Error(`Pipeline error: ${payload.errorCode}`);
            }
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Cancelled by a subsequent start() or unmount; not an error.
        } else {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setIsRunning(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [mergeClassifications],
  );

  return { start, isRunning, progress, complete, error };
}

function parseFrame(frame: string): { event: string; data: unknown } | null {
  if (!frame.trim()) return null;
  let event = '';
  let dataStr = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) dataStr += line.slice(6);
  }
  if (!event || !dataStr) return null;
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}
