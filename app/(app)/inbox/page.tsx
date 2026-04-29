import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InboxView } from '@/components/inbox/InboxView';

export default async function InboxPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  return <InboxView userId={user.id} />;
}
