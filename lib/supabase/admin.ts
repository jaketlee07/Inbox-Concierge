import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

// Bypasses RLS — required for oauth_tokens reads/writes (no authenticated
// policies; service_role only). Never share this client with user code paths.
export function createAdminClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
