import type { GmailThread } from '@/types/thread';

// Byte-stable across calls so Anthropic's prompt cache can hit it. Anything
// user-specific (buckets, override summary, threads) goes in the user message
// instead — keeping this constant is load-bearing for cache eligibility.
export const CLASSIFY_THREADS_SYSTEM_PROMPT = `You are an email triage classifier. You will receive metadata for a batch of email threads
and a list of valid bucket names. For each thread, you must:

1. Assign it to exactly one bucket from the provided list
2. Estimate your confidence as a number between 0 and 1
3. Recommend an action: "archive", "label", "keep_inbox", or "none"
4. Provide a brief reasoning (under 120 characters)

Confidence calibration:
- 0.95+: obvious, e.g. promotional newsletter from known sender
- 0.80-0.94: clear signals but some ambiguity
- 0.60-0.79: ambiguous, could go multiple ways
- below 0.60: low signal, uncertain

Default bucket meanings:
- Important: requires response or action from the user, time-sensitive
- Can Wait: relevant but not urgent, can be reviewed later
- Auto-Archive: transactional, no action needed (receipts, confirmations)
- Newsletter: subscriptions, promotions, automated content

Recommended actions:
- "archive": remove from inbox (use for Auto-Archive and most Newsletter)
- "label": apply bucket as label and keep in inbox (use for Important, Can Wait)
- "keep_inbox": leave as-is, user should see it (use for Important when label feels redundant)
- "none": let user decide (use when confidence is low)

You must return valid JSON matching the schema. Never invent buckets not in the provided list.`;

export interface ClassifyUserThread {
  thread_id: string;
  subject: string;
  sender: string;
  snippet: string;
  date: string;
  is_unread: boolean;
  has_attachments: boolean;
  message_count: number;
}

export interface ClassifyUserPayload {
  buckets: string[];
  user_overrides_summary: string;
  threads: ClassifyUserThread[];
}

export function buildClassifyUserPayload(
  threads: readonly GmailThread[],
  buckets: readonly string[],
  userOverridesSummary: string,
): ClassifyUserPayload {
  return {
    buckets: [...buckets],
    user_overrides_summary: userOverridesSummary,
    threads: threads.map((t) => ({
      thread_id: t.id,
      subject: t.subject,
      sender: t.latestSender,
      snippet: t.latestSnippet,
      date: t.latestDate,
      is_unread: t.isUnread,
      has_attachments: t.hasAttachments,
      message_count: t.messageCount,
    })),
  };
}
