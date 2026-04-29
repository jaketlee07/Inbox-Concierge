import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

// Subset of the threads row this module needs. The orchestrator/executor
// resolve gmail_thread_id ↔ threads.id from the rows returned here.
export interface PendingThread {
  id: string;
  gmail_thread_id: string;
  user_id: string;
}

export async function getThreadsToClassify(
  supabase: SupabaseClient,
  userId: string,
  force = false,
): Promise<PendingThread[]> {
  let query = supabase.from('threads').select('id, gmail_thread_id, user_id').eq('user_id', userId);
  if (!force) {
    query = query.eq('classification_status', 'pending');
  }
  const { data, error } = await query;
  if (error) {
    logger.error('idempotency.fetch_failed', { userId });
    throw new Error(`getThreadsToClassify failed: ${error.message}`);
  }
  return (data ?? []) as PendingThread[];
}

export async function markBatchClassified(
  supabase: SupabaseClient,
  threadIds: readonly string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  const { error } = await supabase
    .from('threads')
    .update({ classification_status: 'classified' })
    .in('id', threadIds);
  if (error) {
    logger.error('idempotency.mark_classified_failed', {});
    throw new Error(`markBatchClassified failed: ${error.message}`);
  }
}

export async function markBatchFailed(
  supabase: SupabaseClient,
  threadIds: readonly string[],
  errorCode: string,
): Promise<void> {
  if (threadIds.length === 0) return;
  const { error } = await supabase
    .from('threads')
    .update({ classification_status: 'error' })
    .in('id', threadIds);
  if (error) {
    logger.error('idempotency.mark_failed_failed', { errorCode });
    throw new Error(`markBatchFailed failed: ${error.message}`);
  }
  logger.warn('idempotency.batch_failed', { errorCode });
}
