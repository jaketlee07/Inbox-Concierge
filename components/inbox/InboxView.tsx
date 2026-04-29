'use client';

import { useMemo } from 'react';
import type { GmailThread } from '@/types/thread';
import { useThreads, type ThreadClassificationView } from '@/hooks/useThreads';
import { useClassification } from '@/hooks/useClassification';
import { SYSTEM_BUCKETS, isSystemBucketName, type SystemBucketName } from '@/lib/buckets';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { BucketColumn } from '@/components/inbox/BucketColumn';

interface InboxViewProps {
  userId: string;
}

const STATUS_BADGE: Record<
  ThreadClassificationView['status'],
  { label: string; variant: 'success' | 'warning' | 'default' }
> = {
  auto_executed: { label: 'Auto-execute', variant: 'success' },
  queued: { label: 'Queue', variant: 'warning' },
  bucketed: { label: 'Bucket only', variant: 'default' },
};

export function InboxView({ userId }: InboxViewProps) {
  const { data, isLoading, isError, error, refetch, isFetching } = useThreads(userId);
  const classification = useClassification(userId);

  const grouped = useMemo(() => {
    const map = new Map<SystemBucketName, GmailThread[]>(SYSTEM_BUCKETS.map((b) => [b.name, []]));
    let unclassified = 0;
    for (const t of data?.threads ?? []) {
      const c = data?.classifications?.[t.id];
      if (!c) {
        unclassified += 1;
        continue;
      }
      if (!isSystemBucketName(c.bucket)) continue;
      map.get(c.bucket)?.push(t);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Date.parse(b.latestDate) - Date.parse(a.latestDate));
    }
    return { map, unclassified };
  }, [data]);

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
              onClick={() => void classification.start()}
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
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 md:grid-cols-[repeat(4,minmax(280px,1fr))] md:overflow-hidden">
        {SYSTEM_BUCKETS.map((b) => (
          <BucketColumn
            key={b.name}
            bucket={b}
            threads={grouped.map.get(b.name) ?? []}
            classifications={data?.classifications}
            isLoading={isLoading}
            renderItem={(thread, c) => <InlineThreadCard thread={thread} classification={c} />}
          />
        ))}
      </div>
    </div>
  );
}

// TODO(5.5): replace with EmailCard that uses useLiveThreadContent for skeleton-then-live render.
function InlineThreadCard({
  thread,
  classification,
}: {
  thread: GmailThread;
  classification?: ThreadClassificationView;
}) {
  const status = classification ? STATUS_BADGE[classification.status] : null;
  const date = thread.latestDate ? new Date(thread.latestDate) : null;
  return (
    <a
      href={`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(thread.id)}`}
      target="_blank"
      rel="noreferrer"
      className="block px-3 py-2 transition hover:bg-neutral-50"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={
            thread.isUnread
              ? 'truncate text-sm font-semibold text-neutral-900'
              : 'truncate text-sm text-neutral-700'
          }
        >
          {thread.subject || '(no subject)'}
        </span>
        {date && (
          <span className="shrink-0 text-[10px] text-neutral-500">
            {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-xs text-neutral-500">
        {thread.latestSender || '(unknown sender)'}
        {thread.messageCount > 1 && ` · ${thread.messageCount} msgs`}
      </div>
      <div className="mt-1 line-clamp-1 text-xs text-neutral-600">{thread.latestSnippet}</div>
      {classification && (
        <div className="mt-1 flex items-center gap-1">
          {status && <Badge variant={status.variant}>{status.label}</Badge>}
          <Badge variant="default">{Math.round(classification.confidence * 100)}%</Badge>
        </div>
      )}
    </a>
  );
}
