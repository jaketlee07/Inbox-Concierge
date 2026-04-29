'use client';

import { signOut } from '@/app/(app)/inbox/actions';
import { recordUserAction } from '@/lib/sentry/breadcrumbs';

export function SignOutForm() {
  return (
    <form action={signOut} onSubmit={() => recordUserAction('sign_out')}>
      <button
        type="submit"
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 transition hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Sign out
      </button>
    </form>
  );
}
