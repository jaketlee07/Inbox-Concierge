'use client';

import { useThreads } from '@/hooks/useThreads';

export function Threads({ userId }: { userId: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useThreads(userId);

  return (
    <section className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-900">Threads</h2>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
        >
          {isFetching ? 'Fetching…' : 'Refresh'}
        </button>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Fetching threads from Gmail…</p>}

      {isError && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error?.message ?? 'Something went wrong'}
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
              {data.threads.map((t) => (
                <li key={t.id} className="px-4 py-3 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={
                        t.isUnread
                          ? 'truncate font-semibold text-neutral-900'
                          : 'truncate text-neutral-700'
                      }
                    >
                      {t.subject || '(no subject)'}
                    </span>
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
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
