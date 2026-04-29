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

async function fetchThreads(): Promise<FetchThreadsResponse> {
  return apiFetch<FetchThreadsResponse>('/api/gmail/fetch-threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export function useThreads(userId: string): UseQueryResult<FetchThreadsResponse, Error> {
  return useQuery({
    queryKey: ['threads', userId],
    queryFn: fetchThreads,
    staleTime: 5 * 60_000,
  });
}
