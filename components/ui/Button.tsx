'use client';

import type { ButtonHTMLAttributes, Ref } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
    'disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-neutral-900 text-white hover:bg-neutral-800 focus-visible:ring-neutral-900',
        secondary:
          'border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50 focus-visible:ring-neutral-400',
        ghost:
          'bg-transparent text-neutral-700 hover:bg-neutral-100 focus-visible:ring-neutral-300',
        danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4 text-sm',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
    ref?: Ref<HTMLButtonElement>;
  };

export function Button({
  ref,
  className,
  variant,
  size,
  loading = false,
  disabled,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading && <Spinner size="sm" aria-hidden="true" />}
      {children}
    </button>
  );
}

export { buttonVariants };
