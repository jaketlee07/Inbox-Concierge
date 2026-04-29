'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { GmailThread } from '@/types/thread';

async function fetchThread(threadId: string): Promise<GmailThread> {
  const res = await fetch(`/api/gmail/thread/${encodeURIComponent(threadId)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as GmailThread;
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
