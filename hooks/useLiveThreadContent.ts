'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/fetch';
import type { GmailThread } from '@/types/thread';

async function fetchThread(threadId: string): Promise<GmailThread> {
  return apiFetch<GmailThread>(`/api/gmail/thread/${encodeURIComponent(threadId)}`);
}

export function useLiveThreadContent(
  threadId: string | undefined,
): UseQueryResult<GmailThread, Error> {
  return useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => fetchThread(threadId as string),
    enabled: !!threadId,
    staleTime: 10 * 60_000,
  });
}
