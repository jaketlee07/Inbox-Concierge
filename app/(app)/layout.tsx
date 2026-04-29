import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { createClient } from '@/lib/supabase/server';
import { ReviewQueue } from '@/components/queue/ReviewQueue';
import { signOut } from './inbox/actions';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="grid h-screen grid-rows-[auto_1fr] bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-neutral-900">Inbox Concierge</h1>
          {/* 5.9 AutopilotBar mounts here */}
          <div data-slot="autopilot-bar" className="min-h-9" />
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-600">{user.email}</span>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 transition hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className="grid min-h-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-h-0 overflow-hidden">{children}</main>
        <aside className="hidden border-l border-neutral-200 bg-white md:block">
          <ReviewQueue userId={user.id} />
        </aside>
      </div>
    </div>
  );
}
