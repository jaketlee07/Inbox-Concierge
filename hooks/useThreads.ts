'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { GmailThread } from '@/types/thread';

export type FetchThreadsResponse = {
  count: number;
  fetched: number;
  threads: GmailThread[];
  failed: string[];
};

async function fetchThreads(): Promise<FetchThreadsResponse> {
  const res = await fetch('/api/gmail/fetch-threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as FetchThreadsResponse;
}

export function useThreads(userId: string): UseQueryResult<FetchThreadsResponse, Error> {
  return useQuery({
    queryKey: ['threads', userId],
    queryFn: fetchThreads,
    staleTime: 5 * 60_000,
  });
}
