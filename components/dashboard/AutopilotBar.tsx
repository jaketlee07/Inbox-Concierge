'use client';

import { useState } from 'react';
import { Pause, Play, Settings, Zap, Clock, Undo2 } from 'lucide-react';
import { useStats } from '@/hooks/useStats';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { Tooltip } from '@/components/ui/Tooltip';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsModal } from '@/components/dashboard/SettingsModal';
import { cn } from '@/lib/utils';

interface AutopilotBarProps {
  userId: string;
}

export function AutopilotBar({ userId }: AutopilotBarProps) {
  const stats = useStats(userId);
  const profile = useProfile(userId);
  const updateProfile = useUpdateProfile(userId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const paused = profile.data?.autopilotPaused ?? false;

  function togglePause() {
    if (!profile.data) return;
    updateProfile.mutate({ autopilotPaused: !paused });
  }

  return (
    <div className="flex items-center gap-2">
      <StatPill
        icon={<Zap className="h-3 w-3" aria-hidden="true" />}
        label="auto-handled today"
        value={stats.data?.autoHandledToday}
        loading={stats.isLoading}
        tone="emerald"
      />
      <StatPill
        icon={<Clock className="h-3 w-3" aria-hidden="true" />}
        label="queued for review"
        value={stats.data?.queuedForReview}
        loading={stats.isLoading}
        tone="amber"
      />
      <StatPill
        icon={<Undo2 className="h-3 w-3" aria-hidden="true" />}
        label="overrides this week"
        value={stats.data?.overridesThisWeek}
        loading={stats.isLoading}
        tone="neutral"
      />

      <Tooltip content={paused ? 'Resume autopilot' : 'Pause autopilot'}>
        <button
          type="button"
          onClick={togglePause}
          disabled={!profile.data}
          aria-pressed={paused}
          className={cn(
            'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition',
            'focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
            'disabled:opacity-50',
            paused
              ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 focus-visible:ring-amber-400'
              : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 focus-visible:ring-neutral-400',
          )}
        >
          {paused ? (
            <Play className="h-3 w-3" aria-hidden="true" />
          ) : (
            <Pause className="h-3 w-3" aria-hidden="true" />
          )}
          {paused ? 'Paused' : 'Auto'}
        </button>
      </Tooltip>

      <Tooltip content="Settings">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>

      {settingsOpen && (
        <SettingsModal userId={userId} open={settingsOpen} onOpenChange={setSettingsOpen} />
      )}
    </div>
  );
}

interface StatPillProps {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  loading: boolean;
  tone: 'emerald' | 'amber' | 'neutral';
}

// Subtle, non-interactive label styling — no border or filled background, so
// the pills don't read as buttons. Tooltip still surfaces the full label.
const TONE_CLASS: Record<StatPillProps['tone'], string> = {
  emerald: 'text-emerald-700',
  amber: 'text-amber-700',
  neutral: 'text-neutral-600',
};

function StatPill({ icon, label, value, loading, tone }: StatPillProps) {
  return (
    <Tooltip content={label}>
      <span
        className={cn(
          'inline-flex h-7 items-center gap-1 px-1 text-xs font-medium tabular-nums',
          TONE_CLASS[tone],
        )}
      >
        {icon}
        {loading ? <Skeleton className="h-3 w-6 bg-current/20" /> : (value ?? 0)}
      </span>
    </Tooltip>
  );
}
