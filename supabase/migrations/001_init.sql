-- Inbox Concierge — initial schema
--
-- PRIVACY CONTRACT (from CLAUDE.md):
--   Persist:     thread ID, sender domain, date, classification result (bucket,
--                confidence, action), status flags. OAuth refresh tokens
--                encrypted via pgcrypto with DB_ENCRYPTION_KEY from env.
--   NEVER persist: subject, snippet, full body, full sender email,
--                  Claude's reasoning text.
--
-- This schema enforces the contract structurally. Adding any column whose name
-- or content would carry the "never persist" set is a privacy bug. Examples
-- of forbidden columns: subject, snippet, body, sender_email, from_email,
-- to_email, email_address, reasoning, rationale, explanation, response_text.

-- ============================================================================
-- Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- Helper functions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- profiles
-- ============================================================================

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  auto_execute_threshold numeric(4, 3) NOT NULL DEFAULT 0.900
    CHECK (auto_execute_threshold >= 0 AND auto_execute_threshold <= 1),
  review_threshold numeric(4, 3) NOT NULL DEFAULT 0.700
    CHECK (review_threshold >= 0 AND review_threshold <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thresholds_coherent CHECK (review_threshold <= auto_execute_threshold)
);

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- buckets
-- ============================================================================

CREATE TABLE public.buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  default_action text CHECK (default_action IN ('archive', 'label', 'none')),
  color text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX buckets_user_id_sort_order_idx
  ON public.buckets (user_id, sort_order);

-- ============================================================================
-- threads
-- Gmail thread metadata. NO subject, snippet, body, or full sender email.
-- ============================================================================

CREATE TABLE public.threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_thread_id text NOT NULL,
  sender_domain text,
  latest_date timestamptz NOT NULL,
  is_unread boolean NOT NULL DEFAULT false,
  has_attachments boolean NOT NULL DEFAULT false,
  gmail_label_ids text[] NOT NULL DEFAULT '{}',
  message_count int NOT NULL CHECK (message_count > 0),
  classification_status text NOT NULL DEFAULT 'pending'
    CHECK (classification_status IN ('pending', 'classified', 'executed', 'queued', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, gmail_thread_id)
);

CREATE TRIGGER threads_set_updated_at
  BEFORE UPDATE ON public.threads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX threads_user_latest_date_idx
  ON public.threads (user_id, latest_date DESC);

CREATE INDEX threads_user_status_idx
  ON public.threads (user_id, classification_status);

-- ============================================================================
-- classifications
-- One row per classification attempt. Re-runs append history; current
-- classification = most recent by created_at. Deliberately no reasoning
-- column — Claude's rationale text never crosses the DB boundary.
-- ============================================================================

CREATE TABLE public.classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  bucket_id uuid NOT NULL REFERENCES public.buckets(id) ON DELETE RESTRICT,
  confidence numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  recommended_action text NOT NULL
    CHECK (recommended_action IN ('archive', 'label', 'none')),
  executed_action text
    CHECK (executed_action IN ('archive', 'label', 'none')),
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT executed_consistent CHECK (
    (executed_action IS NULL AND executed_at IS NULL) OR
    (executed_action IS NOT NULL AND executed_at IS NOT NULL)
  )
);

CREATE INDEX classifications_thread_created_idx
  ON public.classifications (thread_id, created_at DESC);

CREATE INDEX classifications_user_created_idx
  ON public.classifications (user_id, created_at DESC);

-- ============================================================================
-- review_queue
-- Mid-confidence classifications (review_threshold ≤ confidence <
-- auto_execute_threshold) awaiting user approval.
-- ============================================================================

CREATE TABLE public.review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  classification_id uuid NOT NULL REFERENCES public.classifications(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'overridden', 'dismissed')),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resolved_consistent CHECK (
    (status = 'pending' AND resolved_at IS NULL) OR
    (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX review_queue_user_status_created_idx
  ON public.review_queue (user_id, status, created_at DESC);

-- ============================================================================
-- oauth_tokens
-- Google OAuth tokens captured from Supabase Auth's session callback.
-- bytea columns are CRITICAL — pgp_sym_encrypt returns bytea; storing in
-- text would silently corrupt the values (CLAUDE.md "Things That Will Get
-- You Stuck"). Encryption/decryption happens at the application layer with
-- DB_ENCRYPTION_KEY from env. RLS denies all access to the authenticated
-- role; only service_role (which bypasses RLS) can read/write this table.
-- ============================================================================

CREATE TABLE public.oauth_tokens (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google',
  access_token bytea,
  refresh_token bytea NOT NULL,
  expires_at timestamptz,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER oauth_tokens_set_updated_at
  BEFORE UPDATE ON public.oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Auth signup trigger: seed profile + 4 system buckets per user
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id);

  INSERT INTO public.buckets (user_id, name, description, default_action, color, sort_order, is_system)
  VALUES
    (NEW.id, 'Important',    'Email I need to read or act on now.',                    NULL,      '#ef4444', 1, true),
    (NEW.id, 'Can Wait',     'Useful but not urgent — read when I have time.',         NULL,      '#f59e0b', 2, true),
    (NEW.id, 'Auto-Archive', 'Receipts, confirmations, automated notifications.',      'archive', '#10b981', 3, true),
    (NEW.id, 'Newsletter',   'Subscriptions and digests.',                             'archive', '#3b82f6', 4, true);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buckets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_tokens    ENABLE ROW LEVEL SECURITY;

-- profiles: PK matches auth.uid()
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY profiles_delete_own ON public.profiles
  FOR DELETE TO authenticated USING (id = (SELECT auth.uid()));

-- buckets
CREATE POLICY buckets_select_own ON public.buckets
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY buckets_insert_own ON public.buckets
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY buckets_update_own ON public.buckets
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY buckets_delete_own ON public.buckets
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- threads
CREATE POLICY threads_select_own ON public.threads
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY threads_insert_own ON public.threads
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY threads_update_own ON public.threads
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY threads_delete_own ON public.threads
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- classifications
CREATE POLICY classifications_select_own ON public.classifications
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY classifications_insert_own ON public.classifications
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY classifications_update_own ON public.classifications
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY classifications_delete_own ON public.classifications
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- review_queue
CREATE POLICY review_queue_select_own ON public.review_queue
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY review_queue_insert_own ON public.review_queue
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY review_queue_update_own ON public.review_queue
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY review_queue_delete_own ON public.review_queue
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- oauth_tokens: NO authenticated policies. RLS denies all.
-- Access requires service_role (bypasses RLS). The application's server-side
-- token-refresh path will use a service-role client.
