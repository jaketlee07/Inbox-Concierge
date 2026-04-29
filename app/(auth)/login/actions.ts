'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

const REQUESTED_SCOPES = [
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

function resolveOrigin(
  host: string | null,
  forwardedProto: string | null,
  originHeader: string | null,
): string {
  if (originHeader) return originHeader;
  if (!host) return '';
  const proto = forwardedProto ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function signInWithGoogle(): Promise<void> {
  const supabase = await createClient();
  const h = await headers();
  const origin = resolveOrigin(h.get('host'), h.get('x-forwarded-proto'), h.get('origin'));
  const redirectTo = `${origin}/auth/callback`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      scopes: REQUESTED_SCOPES,
      // access_type=offline → Google issues a refresh token.
      // prompt=consent → forces it on every login (otherwise omitted on
      // subsequent logins, which silently breaks revocation recovery).
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });

  if (error || !data?.url) {
    logger.error('auth.signin.failed', {}, error ?? undefined);
    redirect('/login?error=oauth_init_failed');
  }

  redirect(data.url);
}
