'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLiveThreadContent } from '@/hooks/useLiveThreadContent';
import type { FetchThreadsResponse } from '@/hooks/useThreads';
import {
  useApproveReview,
  useOverrideReview,
  useDismissReview,
  type QueueItem,
} from '@/hooks/useReviewQueue';
import { SYSTEM_BUCKETS, isSystemBucketName, type SystemBucket } from '@/lib/buckets';
import { Button } from '@/components/ui/Button';
import { ConfidenceMeter } from '@/components/ui/ConfidenceMeter';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';

interface ReviewCardProps {
  userId: string;
  item: QueueItem;
}

export function ReviewCard({ userId, item }: ReviewCardProps) {
  const { data: thread, isLoading, isError } = useLiveThreadContent(item.threadId);
  const queryClient = useQueryClient();
  const approve = useApproveReview(userId);
  const override = useOverrideReview(userId);
  const dismiss = useDismissReview(userId);
  const [showFullReasoning, setShowFullReasoning] = useState(false);

  const reasoning =
    queryClient.getQueryData<FetchThreadsResponse>(['threads', userId])?.classifications?.[
      item.threadId
    ]?.reasoning ?? '';

  const bucketMeta: SystemBucket | undefined = isSystemBucketName(item.bucket)
    ? SYSTEM_BUCKETS.find((b) => b.name === item.bucket)
    : undefined;

  const isPending = approve.isPending || override.isPending || dismiss.isPending;

  return (
    <article className="flex flex-col gap-2 border-b border-neutral-200 px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
            bucketMeta?.badgeClass ?? 'border-neutral-200 bg-neutral-100 text-neutral-700',
          )}
        >
          {item.bucket}
        </span>
        <ConfidenceMeter value={item.confidence} size="sm" showLabel={false} className="w-12" />
        <span className="text-[10px] text-neutral-500 tabular-nums">
          {Math.round(item.confidence * 100)}%
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-full" />
        </div>
      ) : isError || !thread ? (
        <div className="text-xs text-neutral-500 italic">Couldn&apos;t load preview.</div>
      ) : (
        <div>
          <div
            className={cn(
              'truncate text-sm',
              thread.isUnread ? 'font-semibold text-neutral-900' : 'text-neutral-700',
            )}
          >
            {thread.subject || '(no subject)'}
          </div>
          <div className="mt-0.5 truncate text-xs text-neutral-500">
            {thread.latestSender || '(unknown sender)'}
          </div>
          <div className="mt-1 line-clamp-2 text-xs text-neutral-600">{thread.latestSnippet}</div>
        </div>
      )}

      {reasoning && (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
          <div className={showFullReasoning ? '' : 'line-clamp-3'}>{reasoning}</div>
          <button
            type="button"
            className="mt-1 text-[10px] font-medium text-neutral-500 hover:text-neutral-700"
            onClick={() => setShowFullReasoning((v) => !v)}
          >
            {showFullReasoning ? 'Show less' : 'Show more'}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          loading={approve.isPending}
          disabled={isPending}
          onClick={() => approve.mutate({ queueId: item.queueId })}
        >
          Approve
        </Button>
        <OverrideMenu
          disabled={isPending}
          loading={override.isPending}
          currentBucket={item.bucket}
          onPick={(bucketName) => override.mutate({ queueId: item.queueId, bucketName })}
        />
        <Button
          variant="ghost"
          size="sm"
          loading={dismiss.isPending}
          disabled={isPending}
          onClick={() => dismiss.mutate({ queueId: item.queueId })}
        >
          Dismiss
        </Button>
      </div>
    </article>
  );
}

function OverrideMenu({
  disabled,
  loading,
  currentBucket,
  onPick,
}: {
  disabled: boolean;
  loading: boolean;
  currentBucket: string;
  onPick: (bucketName: string) => void;
}) {
  // Native <select> for accessibility + scope. Reset value="" after each
  // change so the user can re-pick if the mutation fails and the card returns.
  return (
    <label className="relative inline-flex">
      <span className="sr-only">Override bucket</span>
      <select
        disabled={disabled}
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v) onPick(v);
        }}
        className={cn(
          'h-8 cursor-pointer appearance-none rounded-md border border-neutral-300 bg-white px-3 pr-7 text-xs font-medium text-neutral-900 transition hover:bg-neutral-50',
          'focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:outline-none',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
        aria-busy={loading || undefined}
      >
        <option value="" disabled>
          {loading ? 'Overriding…' : 'Override'}
        </option>
        {SYSTEM_BUCKETS.filter((b) => b.name !== currentBucket).map((b) => (
          <option key={b.name} value={b.name}>
            {b.name}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-neutral-500"
      >
        ▾
      </span>
    </label>
  );
}
