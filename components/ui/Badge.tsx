import type { HTMLAttributes, Ref } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium',
  {
    variants: {
      variant: {
        default: 'bg-neutral-100 text-neutral-700 border-neutral-200',
        success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        warning: 'bg-amber-50 text-amber-700 border-amber-200',
        info: 'bg-blue-50 text-blue-700 border-blue-200',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

type BadgeProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants> & {
    ref?: Ref<HTMLSpanElement>;
  };

export function Badge({ ref, variant, className, ...props }: BadgeProps) {
  return <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
