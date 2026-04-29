import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { createClient } from '@/lib/supabase/server';
import { AutopilotBar } from '@/components/dashboard/AutopilotBar';
import { ReviewQueue } from '@/components/queue/ReviewQueue';
import { MobileReviewQueueButton } from '@/components/queue/MobileReviewQueueButton';
import { SignOutForm } from '@/components/inbox/SignOutForm';

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
          <AutopilotBar userId={user.id} />
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-600">{user.email}</span>
          <SignOutForm />
        </div>
      </header>
      <div className="grid min-h-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-h-0 overflow-hidden">{children}</main>
        <aside className="hidden border-l border-neutral-200 bg-white md:block">
          <ReviewQueue userId={user.id} />
        </aside>
      </div>
      <MobileReviewQueueButton userId={user.id} />
    </div>
  );
}
