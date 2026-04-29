import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signInWithGoogle } from './actions';

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

const ERROR_COPY: Record<string, string> = {
  oauth_init_failed: 'Could not start sign-in. Please try again.',
  oauth_denied: 'Sign-in was cancelled.',
  exchange_failed: 'Sign-in failed during the handoff with Google. Please try again.',
  missing_scopes:
    'Sign-in succeeded but Gmail access was not granted. Please approve all requested permissions.',
  no_refresh_token: 'Google did not return a refresh token. Please try signing in again.',
  callback_failed: 'Something went wrong finishing sign-in. Please try again.',
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect('/inbox');
  }

  const { error } = await searchParams;
  const errorMessage = error ? (ERROR_COPY[error] ?? 'Sign-in failed. Please try again.') : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Inbox Concierge</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Sign in with your Google account to triage your Gmail inbox.
        </p>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {errorMessage}
          </div>
        )}

        <form action={signInWithGoogle} className="mt-6">
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800 focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 focus:outline-none"
          >
            Sign in with Google
          </button>
        </form>

        <p className="mt-6 text-xs text-neutral-500">
          We request read, modify, and compose access to triage and archive on your behalf. You can
          revoke access anytime from your Google account settings.
        </p>
      </div>
    </main>
  );
}
