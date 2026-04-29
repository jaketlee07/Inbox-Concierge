'use client';

import type { ReactNode } from 'react';
import type { GmailThread } from '@/types/thread';
import type { ThreadClassificationView } from '@/hooks/useThreads';
import { Badge } from '@/components/ui/Badge';
import { ConfidenceMeter } from '@/components/ui/ConfidenceMeter';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';

interface EmailCardProps {
  thread: GmailThread;
  classification?: ThreadClassificationView;
}

type ActionVariant = 'success' | 'warning' | 'default';

export function EmailCard({ thread, classification }: EmailCardProps) {
  const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(thread.id)}`;
  const { name: senderName, email } = parseSender(thread.latestSender);
  const action = classification ? actionFor(classification) : null;

  const tooltipContent: ReactNode = (
    <div className="space-y-1">
      <div className="font-mono text-[10px] break-all">{email || thread.latestSender}</div>
      {classification?.reasoning && (
        <div className="text-xs leading-snug">{classification.reasoning}</div>
      )}
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <a
        href={gmailUrl}
        target="_blank"
        rel="noreferrer"
        className="block h-[112px] px-3 py-1.5 transition hover:bg-neutral-50 focus-visible:bg-neutral-50 focus-visible:outline-none"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'truncate text-xs',
              thread.isUnread ? 'font-semibold text-neutral-900' : 'text-neutral-600',
            )}
          >
            {senderName || '(unknown sender)'}
          </span>
          <span className="shrink-0 text-[10px] text-neutral-500">
            {relativeDate(thread.latestDate)}
          </span>
        </div>
        <div
          className={cn(
            'mt-0.5 truncate text-sm',
            thread.isUnread ? 'font-semibold text-neutral-900' : 'text-neutral-700',
          )}
        >
          {thread.subject || '(no subject)'}
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs text-neutral-500">{thread.latestSnippet}</div>
        {classification && (
          <div className="mt-1 flex items-center gap-2">
            {action && <Badge variant={action.variant}>{action.label}</Badge>}
            <ConfidenceMeter
              value={classification.confidence}
              size="sm"
              showLabel={false}
              className="w-12"
            />
          </div>
        )}
      </a>
    </Tooltip>
  );
}

function parseSender(raw: string): { name: string; email: string } {
  if (!raw) return { name: '', email: '' };
  const angle = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (angle) {
    const name = angle[1].trim();
    const email = angle[2].trim();
    return { name: name || email, email };
  }
  const trimmed = raw.trim();
  return trimmed.includes('@') ? { name: trimmed, email: trimmed } : { name: trimmed, email: '' };
}

function relativeDate(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'Yesterday';
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function actionFor(c: ThreadClassificationView): { label: string; variant: ActionVariant } {
  if (c.status === 'auto_executed') {
    if (c.recommendedAction === 'archive') return { label: 'Auto-archived', variant: 'success' };
    if (c.recommendedAction === 'label') return { label: 'Labeled', variant: 'success' };
    return { label: 'Auto-handled', variant: 'success' };
  }
  if (c.status === 'queued') return { label: 'Awaiting review', variant: 'warning' };
  return { label: 'Bucketed', variant: 'default' };
}
