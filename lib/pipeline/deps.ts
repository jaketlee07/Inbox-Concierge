import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GmailClient } from '@/lib/gmail/client';
import type { ExecutorContext } from './executor';

// The subset of ExecutorContext that bridges the executor to real Postgres
// and Gmail. The route assembles the full ExecutorContext per-thread by
// adding `userId`, `dbThreadId`, and `bucketId` on top of these deps.
export type ExecutorDeps = Pick<
  ExecutorContext,
  | 'insertClassification'
  | 'markClassificationExecuted'
  | 'insertReviewQueue'
  | 'setThreadStatus'
  | 'archiveGmail'
  | 'addGmailLabel'
>;

export function buildExecutorDeps(supabase: SupabaseClient, gmail: GmailClient): ExecutorDeps {
  return {
    insertClassification: async (input) => {
      const { data, error } = await supabase
        .from('classifications')
        .insert({
          user_id: input.userId,
          thread_id: input.dbThreadId,
          bucket_id: input.bucketId,
          confidence: input.confidence,
          recommended_action: input.recommendedAction,
        })
        .select('id')
        .single();
      if (error || !data) {
        throw new Error(`insertClassification: ${error?.message ?? 'no row returned'}`);
      }
      return data.id;
    },
    markClassificationExecuted: async (classificationId, action) => {
      const { error } = await supabase
        .from('classifications')
        .update({
          executed_action: action,
          executed_at: new Date().toISOString(),
        })
        .eq('id', classificationId);
      if (error) throw new Error(`markClassificationExecuted: ${error.message}`);
    },
    insertReviewQueue: async (classificationId, userId) => {
      const { error } = await supabase
        .from('review_queue')
        .insert({ user_id: userId, classification_id: classificationId });
      if (error) throw new Error(`insertReviewQueue: ${error.message}`);
    },
    setThreadStatus: async (dbThreadId, status) => {
      const { error } = await supabase
        .from('threads')
        .update({ classification_status: status })
        .eq('id', dbThreadId);
      if (error) throw new Error(`setThreadStatus: ${error.message}`);
    },
    archiveGmail: (gmailThreadId) => gmail.archiveThread(gmailThreadId),
    addGmailLabel: (gmailThreadId, label) => gmail.addLabel(gmailThreadId, label),
  };
}
