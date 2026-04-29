import type { Ref, SVGAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const spinnerVariants = cva('animate-spin text-current', {
  variants: {
    size: {
      sm: 'h-3 w-3',
      md: 'h-4 w-4',
      lg: 'h-6 w-6',
    },
  },
  defaultVariants: { size: 'md' },
});

type SpinnerProps = Omit<SVGAttributes<SVGSVGElement>, 'children'> &
  VariantProps<typeof spinnerVariants> & {
    ref?: Ref<SVGSVGElement>;
    label?: string;
  };

export function Spinner({ ref, size, className, label = 'Loading', ...props }: SpinnerProps) {
  return (
    <>
      <svg
        ref={ref}
        viewBox="0 0 24 24"
        fill="none"
        role="status"
        aria-label={label}
        className={cn(spinnerVariants({ size }), className)}
        {...props}
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </>
  );
}
