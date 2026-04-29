'use client';

import { useState } from 'react';
import { useThreads } from '@/hooks/useThreads';
import { useClassifyPreview } from '@/hooks/useClassifyPreview';
import type { ClassifiedThread } from '@/lib/claude/parser';
import type { ExecutionResult } from '@/lib/pipeline/executor';

const BUCKET_BADGE: Record<string, string> = {
  Important: 'bg-red-100 text-red-800 border-red-200',
  'Can Wait': 'bg-amber-100 text-amber-800 border-amber-200',
  'Auto-Archive': 'bg-emerald-100 text-emerald-800 border-emerald-200',
  Newsletter: 'bg-blue-100 text-blue-800 border-blue-200',
};
const DEFAULT_BUCKET_BADGE = 'bg-neutral-100 text-neutral-700 border-neutral-200';

const STATUS_BADGE: Record<ExecutionResult['status'], { label: string; className: string }> = {
  auto_executed: {
    label: 'Auto-execute',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  queued: {
    label: 'Queue for review',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  bucketed: {
    label: 'Bucket only',
    className: 'bg-neutral-50 text-neutral-600 border-neutral-200',
  },
};

interface ThreadDecision {
  classification: ClassifiedThread;
  status: ExecutionResult['status'];
}

export function Threads({ userId }: { userId: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useThreads(userId);
  const [decisions, setDecisions] = useState<Map<string, ThreadDecision>>(new Map());
  const classify = useClassifyPreview();

  async function handleClassify() {
    if (!data) return;
    const ids = data.threads.slice(0, 20).map((t) => t.id);
    if (ids.length === 0) return;
    const result = await classify.mutateAsync(ids);
    const statusByThread = new Map(result.executorResults.map((r) => [r.threadId, r.status]));
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const c of result.classifications) {
        const status = statusByThread.get(c.threadId) ?? 'bucketed';
        next.set(c.threadId, { classification: c, status });
      }
      return next;
    });
  }

  const summary = (() => {
    let auto = 0;
    let queued = 0;
    let bucketed = 0;
    for (const d of decisions.values()) {
      if (d.status === 'auto_executed') auto += 1;
      else if (d.status === 'queued') queued += 1;
      else bucketed += 1;
    }
    return { auto, queued, bucketed, total: decisions.size };
  })();

  return (
    <section className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-900">Threads</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClassify}
            disabled={!data || classify.isPending}
            className="rounded border border-violet-300 bg-violet-50 px-3 py-1 text-sm text-violet-900 hover:bg-violet-100 disabled:opacity-50"
          >
            {classify.isPending ? 'Classifying…' : 'Classify (preview)'}
          </button>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
          >
            {isFetching ? 'Fetching…' : 'Refresh'}
          </button>
        </div>
      </div>

      {summary.total > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs">
          <span className="font-medium text-neutral-700">{summary.total} classified (preview)</span>
          <span className="text-emerald-700"> {summary.auto} auto-execute</span>
          <span className="text-amber-700"> {summary.queued} queue</span>
          <span className="text-neutral-600"> {summary.bucketed} bucket only</span>
          <span className="ml-auto text-[10px] text-neutral-500">
            no Gmail actions fired · no DB writes
          </span>
        </div>
      )}

      {isLoading && <p className="text-sm text-neutral-500">Fetching threads from Gmail…</p>}

      {isError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error?.message ?? 'Something went wrong'}
        </div>
      )}

      {classify.isError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          Classify failed: {classify.error?.message}
        </div>
      )}

      {data && (
        <>
          <p className="mb-3 text-xs text-neutral-500">
            {data.fetched} fetched, {data.failed.length} failed (of {data.count})
            {isFetching && ' · refreshing…'}
          </p>
          {data.threads.length === 0 ? (
            <p className="text-sm text-neutral-500">No threads.</p>
          ) : (
            <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
              {data.threads.map((t) => {
                const d = decisions.get(t.id);
                const c = d?.classification;
                const statusBadge = d ? STATUS_BADGE[d.status] : null;
                return (
                  <li key={t.id} className="px-4 py-3 text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="flex min-w-0 items-baseline gap-2">
                        {c && (
                          <span
                            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${BUCKET_BADGE[c.bucket] ?? DEFAULT_BUCKET_BADGE}`}
                            title={`${c.recommendedAction} · ${c.reasoning}`}
                          >
                            {c.bucket} {Math.round(c.confidence * 100)}%
                          </span>
                        )}
                        {statusBadge && (
                          <span
                            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusBadge.className}`}
                          >
                            {statusBadge.label}
                          </span>
                        )}
                        <span
                          className={
                            t.isUnread
                              ? 'truncate font-semibold text-neutral-900'
                              : 'truncate text-neutral-700'
                          }
                        >
                          {t.subject || '(no subject)'}
                        </span>
                      </div>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {t.latestDate ? new Date(t.latestDate).toLocaleString() : ''}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {t.latestSender || '(unknown sender)'}
                      {t.messageCount > 1 && ` · ${t.messageCount} messages`}
                      {t.hasAttachments && ' · attachment'}
                    </div>
                    <div className="mt-1 line-clamp-1 text-xs text-neutral-600">
                      {t.latestSnippet}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
