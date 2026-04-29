'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { toast } from '@/components/ui/Toast';
import { apiFetch } from '@/lib/api/fetch';
import type { BucketsResponse } from '@/hooks/useBuckets';
import type { StatsResponse } from '@/hooks/useStats';
import type { FetchThreadsResponse, ThreadClassificationView } from '@/hooks/useThreads';

export type RecommendedAction = 'archive' | 'label' | 'none';

export interface QueueItem {
  queueId: string;
  classificationId: string;
  threadId: string;
  bucket: string;
  confidence: number;
  recommendedAction: RecommendedAction;
}

export interface QueueResponse {
  items: QueueItem[];
}

interface ApproveVars {
  queueId: string;
}
interface OverrideVars {
  queueId: string;
  bucketName: string;
}
interface DismissVars {
  queueId: string;
}

interface OptimisticContext {
  prevQueue: QueueResponse | undefined;
  item: QueueItem | undefined;
}

async function fetchQueue(): Promise<QueueResponse> {
  return apiFetch<QueueResponse>('/api/queue');
}

async function postJson(url: string, body: unknown): Promise<void> {
  await apiFetch<unknown>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function useReviewQueue(userId: string): UseQueryResult<QueueResponse, Error> {
  return useQuery({
    queryKey: ['review-queue', userId],
    queryFn: fetchQueue,
    staleTime: 30_000,
  });
}

function patchClassification(
  queryClient: QueryClient,
  userId: string,
  threadId: string,
  patch: Partial<ThreadClassificationView>,
): void {
  queryClient.setQueryData<FetchThreadsResponse | undefined>(['threads', userId], (prev) => {
    if (!prev) return prev;
    const existing = prev.classifications?.[threadId];
    if (!existing) return prev;
    return {
      ...prev,
      classifications: {
        ...prev.classifications,
        [threadId]: { ...existing, ...patch },
      },
    };
  });
}

// Optimistically nudge the stats counters in-cache so the AutopilotBar reflects
// the action immediately without a /api/stats round-trip. Server is still
// authoritative on next window-focus refetch.
function patchStats(queryClient: QueryClient, userId: string, delta: Partial<StatsResponse>): void {
  queryClient.setQueryData<StatsResponse | undefined>(['stats', userId], (prev) => {
    if (!prev) return prev;
    return {
      autoHandledToday: Math.max(0, prev.autoHandledToday + (delta.autoHandledToday ?? 0)),
      queuedForReview: Math.max(0, prev.queuedForReview + (delta.queuedForReview ?? 0)),
      overridesThisWeek: Math.max(0, prev.overridesThisWeek + (delta.overridesThisWeek ?? 0)),
    };
  });
}

function useOptimisticQueueMutation<TVars extends { queueId: string }>(args: {
  userId: string;
  fn: (vars: TVars) => Promise<void>;
  errorLabel: string;
  applyToThreads: (item: QueueItem, vars: TVars, queryClient: QueryClient) => void;
}): UseMutationResult<void, Error, TVars, OptimisticContext> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, TVars, OptimisticContext>({
    mutationFn: args.fn,
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['review-queue', args.userId] });
      const prevQueue = queryClient.getQueryData<QueueResponse>(['review-queue', args.userId]);
      const item = prevQueue?.items.find((i) => i.queueId === vars.queueId);
      queryClient.setQueryData<QueueResponse>(['review-queue', args.userId], (old) =>
        old ? { items: old.items.filter((i) => i.queueId !== vars.queueId) } : old,
      );
      return { prevQueue, item };
    },
    onSuccess: (_data, vars, ctx) => {
      if (ctx?.item) args.applyToThreads(ctx.item, vars, queryClient);
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevQueue) {
        queryClient.setQueryData(['review-queue', args.userId], ctx.prevQueue);
      }
      toast.error(`${args.errorLabel}. Try again.`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['review-queue', args.userId] });
      // Stats are patched optimistically in each mutation's applyToThreads
      // callback — skip the /api/stats invalidation that previously fired
      // 1–3 round-trips per click. Server reconciles on next window focus.
      // Threads cache is also patched in applyToThreads; re-fetching would
      // just re-confirm the same state 5–15 s later.
    },
  });
}

export function useApproveReview(
  userId: string,
): UseMutationResult<void, Error, ApproveVars, OptimisticContext> {
  return useOptimisticQueueMutation<ApproveVars>({
    userId,
    fn: (vars) => postJson('/api/queue/approve', vars),
    errorLabel: "Couldn't approve",
    applyToThreads: (item, _vars, qc) => {
      const willExecute = item.recommendedAction !== 'none';
      patchClassification(qc, userId, item.threadId, {
        status: willExecute ? 'auto_executed' : 'bucketed',
      });
      patchStats(qc, userId, {
        queuedForReview: -1,
        autoHandledToday: willExecute ? 1 : 0,
      });
    },
  });
}

export function useOverrideReview(
  userId: string,
): UseMutationResult<void, Error, OverrideVars, OptimisticContext> {
  return useOptimisticQueueMutation<OverrideVars>({
    userId,
    fn: (vars) => postJson('/api/queue/override', vars),
    errorLabel: "Couldn't override",
    applyToThreads: (item, vars, qc) => {
      // Read default_action from the live buckets cache so custom buckets work
      // too. If the cache is empty (rare), fall back to no action — server is
      // authoritative and will refresh state on next ['threads'] read.
      const bucketsCache = qc.getQueryData<BucketsResponse>(['buckets', userId]);
      const newBucket = bucketsCache?.buckets.find((b) => b.name === vars.bucketName);
      const newAction = newBucket?.defaultAction ?? null;
      patchClassification(qc, userId, item.threadId, {
        bucket: vars.bucketName,
        recommendedAction: newAction ?? 'none',
        status: newAction === null ? 'bucketed' : 'auto_executed',
      });
      patchStats(qc, userId, {
        queuedForReview: -1,
        overridesThisWeek: 1,
        autoHandledToday: newAction !== null ? 1 : 0,
      });
    },
  });
}

export function useDismissReview(
  userId: string,
): UseMutationResult<void, Error, DismissVars, OptimisticContext> {
  return useOptimisticQueueMutation<DismissVars>({
    userId,
    fn: (vars) => postJson('/api/queue/dismiss', vars),
    errorLabel: "Couldn't dismiss",
    applyToThreads: (item, _vars, qc) => {
      patchClassification(qc, userId, item.threadId, { status: 'bucketed' });
      patchStats(qc, userId, { queuedForReview: -1 });
    },
  });
}
