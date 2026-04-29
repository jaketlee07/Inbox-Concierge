import type { HTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement>;
};

export function Skeleton({ ref, className, ...props }: SkeletonProps) {
  return (
    <div
      ref={ref}
      className={cn('animate-pulse rounded-md bg-neutral-200', className)}
      {...props}
    />
  );
}
