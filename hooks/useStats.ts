'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

export interface StatsResponse {
  autoHandledToday: number;
  queuedForReview: number;
  overridesThisWeek: number;
}

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch('/api/stats', { method: 'GET' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as StatsResponse;
}

export function useStats(userId: string): UseQueryResult<StatsResponse, Error> {
  return useQuery({
    queryKey: ['stats', userId],
    queryFn: fetchStats,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
