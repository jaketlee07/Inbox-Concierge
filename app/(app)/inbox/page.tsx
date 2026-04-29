import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signOut } from './actions';
import { Threads } from './Threads';

export default async function InboxPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
        <h1 className="text-lg font-semibold text-neutral-900">Inbox Concierge</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-600">{user.email}</span>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded border border-neutral-300 bg-white px-3 py-1 hover:bg-neutral-100"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <Threads />
    </main>
  );
}
