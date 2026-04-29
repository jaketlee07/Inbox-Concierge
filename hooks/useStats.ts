'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/fetch';

export interface StatsResponse {
  autoHandledToday: number;
  queuedForReview: number;
  overridesThisWeek: number;
}

async function fetchStats(): Promise<StatsResponse> {
  return apiFetch<StatsResponse>('/api/stats');
}

export function useStats(userId: string): UseQueryResult<StatsResponse, Error> {
  return useQuery({
    queryKey: ['stats', userId],
    queryFn: fetchStats,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
