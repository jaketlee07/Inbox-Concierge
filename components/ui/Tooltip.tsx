'use client';

import type { ReactNode } from 'react';
import * as TooltipPrim from '@radix-ui/react-tooltip';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayDuration?: number;
  asChild?: boolean;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  delayDuration = 300,
  asChild = true,
}: TooltipProps) {
  return (
    <TooltipPrim.Root delayDuration={delayDuration}>
      <TooltipPrim.Trigger asChild={asChild}>{children}</TooltipPrim.Trigger>
      <TooltipPrim.Portal>
        <TooltipPrim.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-md bg-neutral-900 px-2 py-1 text-xs text-white shadow"
        >
          {content}
          <TooltipPrim.Arrow className="fill-neutral-900" />
        </TooltipPrim.Content>
      </TooltipPrim.Portal>
    </TooltipPrim.Root>
  );
}
