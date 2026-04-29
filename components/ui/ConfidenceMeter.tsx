import type { HTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

type ConfidenceMeterProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  value: number;
  showLabel?: boolean;
  size?: 'sm' | 'md';
  ref?: Ref<HTMLDivElement>;
};

function colorFor(value: number): string {
  if (value >= 0.9) return 'bg-emerald-500';
  if (value >= 0.7) return 'bg-amber-500';
  return 'bg-red-500';
}

export function ConfidenceMeter({
  ref,
  value,
  showLabel = true,
  size = 'md',
  className,
  ...props
}: ConfidenceMeterProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);

  return (
    <div ref={ref} className={cn('flex items-center gap-2', className)} {...props}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={clamped}
        aria-valuetext={`${pct}%`}
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-neutral-200',
          size === 'sm' ? 'h-1' : 'h-1.5',
        )}
      >
        {/* width is runtime-derived from a 0..1 prop; Tailwind v4 JIT cannot generate arbitrary percent widths */}
        <div
          className={cn('h-full transition-all', colorFor(clamped))}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && <span className="shrink-0 text-xs text-neutral-600 tabular-nums">{pct}%</span>}
    </div>
  );
}
