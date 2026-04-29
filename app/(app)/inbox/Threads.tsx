'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GmailThread } from '@/types/thread';

type ApiResponse = {
  count: number;
  fetched: number;
  threads: GmailThread[];
  failed: string[];
};

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ApiResponse };

export function Threads() {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const fetchThreads = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/gmail/fetch-threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        const message = body.error?.message ?? `Request failed (${res.status})`;
        setState({ kind: 'error', message });
        return;
      }
      const data = (await res.json()) as ApiResponse;
      setState({ kind: 'ready', data });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Network error',
      });
    }
  }, []);

  useEffect(() => {
    // Initial fetch on mount. The React 19 lint rule warns about setState
    // inside effects but this "fetch on mount" pattern is the intended use.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchThreads();
  }, [fetchThreads]);

  return (
    <section className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-900">Threads</h2>
        <button
          type="button"
          onClick={fetchThreads}
          disabled={state.kind === 'loading'}
          className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
        >
          {state.kind === 'loading' ? 'Fetching…' : 'Refresh'}
        </button>
      </div>

      {state.kind === 'loading' && (
        <p className="text-sm text-neutral-500">Fetching threads from Gmail…</p>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {state.message}
        </div>
      )}

      {state.kind === 'ready' && (
        <>
          <p className="mb-3 text-xs text-neutral-500">
            {state.data.fetched} fetched, {state.data.failed.length} failed (of {state.data.count})
          </p>
          {state.data.threads.length === 0 ? (
            <p className="text-sm text-neutral-500">No threads.</p>
          ) : (
            <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
              {state.data.threads.map((t) => (
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
