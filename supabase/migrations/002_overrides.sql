-- Phase 5.7: capture user disagreements with Claude's bucket assignment.
-- A row here means the user clicked "Override" in the review queue and chose
-- a different bucket than the one suggested. No reasoning column — Claude
-- text is never persisted (privacy invariant).

CREATE TABLE public.overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  classification_id uuid NOT NULL REFERENCES public.classifications(id) ON DELETE CASCADE,
  original_bucket_id uuid NOT NULL REFERENCES public.buckets(id) ON DELETE RESTRICT,
  new_bucket_id uuid NOT NULL REFERENCES public.buckets(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX overrides_user_created_idx
  ON public.overrides (user_id, created_at DESC);

ALTER TABLE public.overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY overrides_select_own ON public.overrides
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY overrides_insert_own ON public.overrides
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
