-- Phase 5.9: pause toggle for the autopilot. When true, the executor
-- queues mid-confidence threads instead of auto-archiving / auto-labeling.
-- Read by /api/classify when constructing ExecutorThresholds.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS autopilot_paused boolean NOT NULL DEFAULT false;
