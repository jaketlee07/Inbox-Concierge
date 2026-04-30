'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/fetch';
import type { GmailThread } from '@/types/thread';

// Per-thread classification view, populated by useClassification's
// setQueryData merge as SSE batches arrive. Lives on the threads cache so
// the inbox UI reads a single source.
export type ThreadClassificationView = {
  bucket: string;
  confidence: number;
  recommendedAction: 'archive' | 'label' | 'keep_inbox' | 'none';
  reasoning: string;
  status: 'auto_executed' | 'queued' | 'bucketed';
};

export type FetchThreadsResponse = {
  count: number;
  fetched: number;
  threads: GmailThread[];
  failed: string[];
  classifications?: Record<string, ThreadClassificationView>;
};

async function fetchThreads(userId: string): Promise<FetchThreadsResponse> {
  const res = await apiFetch<FetchThreadsResponse>('/api/gmail/fetch-threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  // Reasoning is intentionally empty in the server response (privacy invariant).
  // Hydrate from localStorage — written by useClassification's merge after each
  // SSE batch. Stays on-device, never crosses the network.
  if (res.classifications && typeof window !== 'undefined') {
    for (const [threadId, view] of Object.entries(res.classifications)) {
      if (!view.reasoning) {
        try {
          const cached = window.localStorage.getItem(`ic:reasoning:${userId}:${threadId}`);
          if (cached) view.reasoning = cached;
        } catch {
          // private mode / disabled storage — best-effort, skip.
        }
      }
    }
  }
  return res;
}

export function useThreads(userId: string): UseQueryResult<FetchThreadsResponse, Error> {
  return useQuery({
    queryKey: ['threads', userId],
    queryFn: () => fetchThreads(userId),
    staleTime: 5 * 60_000,
  });
}
