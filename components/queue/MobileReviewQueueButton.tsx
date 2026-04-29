'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Inbox } from 'lucide-react';
import { ReviewQueue } from '@/components/queue/ReviewQueue';
import { useReviewQueue } from '@/hooks/useReviewQueue';
import { cn } from '@/lib/utils';

interface MobileReviewQueueButtonProps {
  userId: string;
}

export function MobileReviewQueueButton({ userId }: MobileReviewQueueButtonProps) {
  const [open, setOpen] = useState(false);
  const queue = useReviewQueue(userId);
  const count = queue.data?.items.length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open review queue"
          className={cn(
            'fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full',
            'bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-lg transition',
            'hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-neutral-400',
            'focus-visible:ring-offset-2 focus-visible:outline-none',
            'md:hidden',
          )}
        >
          <Inbox className="h-4 w-4" aria-hidden="true" />
          Queue
          {count > 0 && (
            <span className="rounded-full bg-white px-1.5 text-xs font-semibold text-neutral-900 tabular-nums">
              {count}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 md:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex h-[85vh] flex-col',
            'rounded-t-lg border-t border-neutral-200 bg-white shadow-xl focus:outline-none',
            'md:hidden',
          )}
        >
          <Dialog.Title className="sr-only">Review queue</Dialog.Title>
          <ReviewQueue userId={userId} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
