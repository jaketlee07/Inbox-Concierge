'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Slider from '@radix-ui/react-slider';
import { RotateCw, FolderPlus } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { BucketManager } from '@/components/buckets/BucketManager';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { useClassification } from '@/hooks/useClassification';

interface SettingsModalProps {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const AUTO_MIN = 0.7;
const AUTO_MAX = 0.99;
const QUEUE_MIN = 0.5;
const QUEUE_MAX = 0.89;
const STEP = 0.01;

export function SettingsModal({ userId, open, onOpenChange }: SettingsModalProps) {
  const profile = useProfile(userId);
  const updateProfile = useUpdateProfile(userId);
  const queryClient = useQueryClient();
  const classification = useClassification(userId);

  const [autoExecute, setAutoExecute] = useState(0.9);
  const [queue, setQueue] = useState(0.7);
  const [paused, setPaused] = useState(false);
  const [confirmReclassifyOpen, setConfirmReclassifyOpen] = useState(false);
  const [bucketManagerOpen, setBucketManagerOpen] = useState(false);

  // Re-seed local state when the modal transitions to open with loaded data,
  // or when profile.data refreshes while open. Canonical React 19 pattern:
  // compare previous state during render and call setState — React discards
  // the in-progress render and re-renders with the new state.
  const [seedKey, setSeedKey] = useState<typeof profile.data | null>(null);
  if (open && profile.data && profile.data !== seedKey) {
    setSeedKey(profile.data);
    setAutoExecute(profile.data.autoExecuteThreshold);
    setQueue(profile.data.reviewThreshold);
    setPaused(profile.data.autopilotPaused);
  }
  if (!open && seedKey !== null) {
    setSeedKey(null);
  }

  function handleAutoChange(v: number) {
    setAutoExecute(v);
    // Keep queue strictly below auto.
    if (queue >= v) setQueue(Math.max(QUEUE_MIN, +(v - STEP).toFixed(2)));
  }

  function handleQueueChange(v: number) {
    // Clamp queue strictly below current auto-execute.
    const clamped = Math.min(v, +(autoExecute - STEP).toFixed(2));
    setQueue(clamped);
  }

  async function handleSave() {
    await updateProfile.mutateAsync({
      autoExecuteThreshold: autoExecute,
      reviewThreshold: queue,
      autopilotPaused: paused,
    });
    queryClient.invalidateQueries({ queryKey: ['stats', userId] });
    onOpenChange(false);
  }

  function handleReclassify() {
    setConfirmReclassifyOpen(false);
    onOpenChange(false);
    void classification.start(true);
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="Settings"
        description="Tune autopilot thresholds and pause auto-execution."
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={updateProfile.isPending}
              disabled={profile.isLoading}
              onClick={handleSave}
            >
              Save
            </Button>
          </>
        }
      >
        {profile.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            <ThresholdSlider
              label="Auto-execute threshold"
              hint="At or above this confidence, classifications fire Gmail actions automatically."
              value={autoExecute}
              min={AUTO_MIN}
              max={AUTO_MAX}
              step={STEP}
              accent="bg-emerald-500"
              onChange={handleAutoChange}
            />
            <ThresholdSlider
              label="Queue threshold"
              hint={`Confidence between this and auto-execute lands in the review queue. Must be below ${formatPct(autoExecute)}.`}
              value={queue}
              min={QUEUE_MIN}
              max={Math.min(QUEUE_MAX, +(autoExecute - STEP).toFixed(2))}
              step={STEP}
              accent="bg-amber-500"
              onChange={handleQueueChange}
            />
            <label className="flex items-start gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-neutral-300 text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
              />
              <span>
                <span className="font-medium text-neutral-900">Pause autopilot</span>
                <span className="mt-0.5 block text-xs text-neutral-600">
                  Queue everything mid-confidence instead of auto-executing. Approve / Override /
                  Dismiss in the sidebar still works.
                </span>
              </span>
            </label>
            <div className="border-t border-neutral-200 pt-4">
              <Button variant="secondary" size="sm" onClick={() => setBucketManagerOpen(true)}>
                <FolderPlus className="h-3 w-3" aria-hidden="true" />
                Manage buckets
              </Button>
              <p className="mt-1 text-xs text-neutral-500">Add or remove custom buckets.</p>
            </div>
            <div className="border-t border-neutral-200 pt-4">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmReclassifyOpen(true)}
                disabled={classification.isRunning}
              >
                <RotateCw className="h-3 w-3" aria-hidden="true" />
                Reclassify all threads
              </Button>
              <p className="mt-1 text-xs text-neutral-500">
                Re-runs Claude on every fetched thread, ignoring idempotency.
              </p>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={confirmReclassifyOpen}
        onOpenChange={setConfirmReclassifyOpen}
        title="Reclassify all threads?"
        description="This re-runs Claude on every fetched thread, overwrites existing classifications, and may auto-archive or label threads in your Gmail."
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirmReclassifyOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={handleReclassify}>
              Reclassify
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-600">
          You can&apos;t undo Gmail mutations once they fire.
        </p>
      </Modal>

      {bucketManagerOpen && (
        <BucketManager
          userId={userId}
          open={bucketManagerOpen}
          onOpenChange={setBucketManagerOpen}
        />
      )}
    </>
  );
}

interface ThresholdSliderProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  accent: string;
  onChange: (v: number) => void;
}

function ThresholdSlider({
  label,
  hint,
  value,
  min,
  max,
  step,
  accent,
  onChange,
}: ThresholdSliderProps) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-neutral-900">{label}</span>
        <span className="text-sm text-neutral-700 tabular-nums">{formatPct(value)}</span>
      </div>
      <Slider.Root
        className="relative mt-2 flex h-5 w-full touch-none items-center select-none"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(values) => onChange(values[0])}
        aria-label={label}
      >
        <Slider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-neutral-200">
          <Slider.Range className={`absolute h-full ${accent}`} />
        </Slider.Track>
        <Slider.Thumb className="block h-4 w-4 rounded-full border border-neutral-300 bg-white shadow focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:outline-none" />
      </Slider.Root>
      <p className="mt-1 text-xs text-neutral-500">{hint}</p>
    </div>
  );
}

function formatPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
