'use client';

import { useMemo } from 'react';
import { Inbox } from 'lucide-react';
import type { GmailThread } from '@/types/thread';
import { useThreads } from '@/hooks/useThreads';
import { useClassification } from '@/hooks/useClassification';
import { useBuckets } from '@/hooks/useBuckets';
import { Button } from '@/components/ui/Button';
import { BucketColumn } from '@/components/inbox/BucketColumn';
import { EmailCard } from '@/components/inbox/EmailCard';
import { recordUserAction } from '@/lib/sentry/breadcrumbs';

interface InboxViewProps {
  userId: string;
}

export function InboxView({ userId }: InboxViewProps) {
  const { data, isLoading, isError, error, refetch, isFetching } = useThreads(userId);
  const classification = useClassification(userId);
  const buckets = useBuckets(userId);

  const sortedBuckets = useMemo(
    () => [...(buckets.data?.buckets ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [buckets.data],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, GmailThread[]>();
    for (const b of sortedBuckets) map.set(b.name, []);
    let unclassified = 0;
    for (const t of data?.threads ?? []) {
      const c = data?.classifications?.[t.id];
      if (!c) {
        unclassified += 1;
        continue;
      }
      const arr = map.get(c.bucket);
      // Bucket no longer in user's list (e.g., recently deleted) — drop silently;
      // the next reclassify will re-route this thread.
      if (arr) arr.push(t);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Date.parse(b.latestDate) - Date.parse(a.latestDate));
    }
    return { map, unclassified };
  }, [data, sortedBuckets]);

  const totalThreads = data?.threads.length ?? 0;
  const canClassify = totalThreads > 0 && !classification.isRunning;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-neutral-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-900">Inbox</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => refetch()}
              loading={isFetching && !classification.isRunning}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                recordUserAction('classify_started', { force: false });
                void classification.start();
              }}
              disabled={!canClassify}
              loading={classification.isRunning}
            >
              {classification.isRunning ? 'Classifying' : 'Classify inbox'}
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
          {data && (
            <span>
              {data.fetched} fetched
              {data.failed.length > 0 && `, ${data.failed.length} failed`}
            </span>
          )}
          {classification.progress && (
            <span>
              Classified {classification.progress.classified} / {classification.progress.total}
              {classification.progress.autoExecuted > 0 &&
                ` · ${classification.progress.autoExecuted} auto`}
              {classification.progress.queued > 0 && ` · ${classification.progress.queued} queued`}
            </span>
          )}
          {grouped.unclassified > 0 && !classification.isRunning && (
            <span>
              {grouped.unclassified} unclassified — click <strong>Classify</strong> to bucket.
            </span>
          )}
        </div>
        {(isError || classification.error) && (
          <div
            role="alert"
            className="mt-2 flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            <span>
              {isError
                ? (error?.message ?? 'Failed to fetch threads')
                : (classification.error?.message ?? 'Classification failed')}
            </span>
            {isError && (
              <Button variant="secondary" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
      {!isLoading && data && data.threads.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center text-neutral-500">
          <Inbox className="mb-3 h-10 w-10 text-neutral-300" aria-hidden="true" />
          <p className="text-sm">Your inbox appears empty.</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => refetch()}
            loading={isFetching}
          >
            Refresh
          </Button>
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 md:overflow-x-auto md:overflow-y-hidden"
          // dynamic column count — Tailwind JIT can't generate runtime grid-template strings
          style={{
            gridTemplateColumns:
              sortedBuckets.length > 0
                ? `repeat(${sortedBuckets.length}, minmax(280px, 1fr))`
                : undefined,
          }}
        >
          {sortedBuckets.map((b) => (
            <BucketColumn
              key={b.id}
              bucket={b}
              threads={grouped.map.get(b.name) ?? []}
              classifications={data?.classifications}
              isLoading={isLoading || buckets.isLoading}
              renderItem={(thread, c) => <EmailCard threadId={thread.id} classification={c} />}
            />
          ))}
        </div>
      )}
    </div>
  );
}
