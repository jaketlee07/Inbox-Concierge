'use client';

import { CheckCheck } from 'lucide-react';
import { useReviewQueue } from '@/hooks/useReviewQueue';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { ReviewCard } from '@/components/queue/ReviewCard';

interface ReviewQueueProps {
  userId: string;
}

export function ReviewQueue({ userId }: ReviewQueueProps) {
  const { data, isLoading, isError } = useReviewQueue(userId);
  const items = data?.items ?? [];

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">Review queue</h2>
        {!isLoading && <Badge variant="default">{items.length}</Badge>}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : isError ? (
          <div className="px-4 py-6 text-center text-sm text-neutral-500">
            Couldn&apos;t load the queue.
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-neutral-400">
            <CheckCheck className="mb-2 h-8 w-8" aria-hidden="true" />
            <p className="text-xs">All caught up. Nothing to review.</p>
          </div>
        ) : (
          <div>
            {items.map((item) => (
              <ReviewCard key={item.queueId} userId={userId} item={item} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
