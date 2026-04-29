'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { Inbox } from 'lucide-react';
import type { GmailThread } from '@/types/thread';
import type { ThreadClassificationView } from '@/hooks/useThreads';
import type { SystemBucket } from '@/lib/buckets';
import { Skeleton } from '@/components/ui/Skeleton';

const ROW_HEIGHT = 112;
const VIRTUALIZE_THRESHOLD = 50;
const DESKTOP_QUERY = '(min-width: 768px)';

interface BucketColumnProps {
  bucket: SystemBucket;
  threads: GmailThread[];
  classifications?: Record<string, ThreadClassificationView>;
  isLoading: boolean;
  renderItem: (thread: GmailThread, classification?: ThreadClassificationView) => ReactNode;
}

export function BucketColumn({
  bucket,
  threads,
  classifications,
  isLoading,
  renderItem,
}: BucketColumnProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerHeight = useElementHeight(containerRef);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const shouldVirtualize = isDesktop && threads.length > VIRTUALIZE_THRESHOLD;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-md border border-neutral-200 bg-white">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white px-3 py-2">
        <div className="flex items-center gap-2">
          {/* runtime hex color from per-bucket config; Tailwind JIT cannot generate arbitrary palettes */}
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: bucket.color }}
            aria-hidden="true"
          />
          <h3 className="text-sm font-semibold text-neutral-900">{bucket.name}</h3>
        </div>
        <span className="text-xs text-neutral-500 tabular-nums">{threads.length}</span>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <SkeletonList />
        ) : threads.length === 0 ? (
          <EmptyState />
        ) : shouldVirtualize && containerHeight > 0 ? (
          <FixedSizeList
            height={containerHeight}
            itemCount={threads.length}
            itemSize={ROW_HEIGHT}
            width="100%"
            itemData={{ threads, classifications, renderItem }}
          >
            {VirtualRow}
          </FixedSizeList>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {threads.map((t) => (
              <li key={t.id}>{renderItem(t, classifications?.[t.id])}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface VirtualRowData {
  threads: GmailThread[];
  classifications?: Record<string, ThreadClassificationView>;
  renderItem: (thread: GmailThread, classification?: ThreadClassificationView) => ReactNode;
}

function VirtualRow({ index, style, data }: ListChildComponentProps<VirtualRowData>) {
  const t = data.threads[index];
  return (
    <div style={style} className="border-b border-neutral-100">
      {data.renderItem(t, data.classifications?.[t.id])}
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-neutral-400">
      <Inbox className="mb-2 h-8 w-8" aria-hidden="true" />
      <p className="text-xs">No emails here yet.</p>
    </div>
  );
}

function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
