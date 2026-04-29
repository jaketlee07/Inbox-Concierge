import 'server-only';
import { decrypt, encrypt } from '@/lib/crypto';
import { env } from '@/lib/env';
import { AppError, OAuthRevokedError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

type TokenRow = {
  access_token: string | null;
  refresh_token: string;
  expires_at: string | null;
};

export async function getAccessToken(userId: string): Promise<string> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from('oauth_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .single<TokenRow>();

  if (error || !data) {
    throw new AppError('OAUTH_TOKEN_MISSING', 'No oauth tokens for user', 401, error);
  }

  const expiresAtMs = data.expires_at ? Date.parse(data.expires_at) : 0;
  const now = Date.now();

  if (data.access_token && expiresAtMs - now > EXPIRY_BUFFER_MS) {
    return decrypt(data.access_token);
  }

  const refreshToken = decrypt(data.refresh_token);
  const refreshed = await refreshAccessToken(refreshToken, userId);

  const newExpiresAt = new Date(now + refreshed.expires_in * 1000).toISOString();
  const { error: updateErr } = await admin
    .from('oauth_tokens')
    .update({
      access_token: encrypt(refreshed.access_token),
      expires_at: newExpiresAt,
    })
    .eq('user_id', userId);

  if (updateErr) {
    // Persist failed but Google handed us a valid access token. Return it; the
    // next call will re-refresh, which is acceptable.
    logger.error('gmail.token.persist_failed', { userId }, updateErr);
  }

  logger.info('gmail.token.refreshed', { userId });
  return refreshed.access_token;
}

async function refreshAccessToken(
  refreshToken: string,
  userId: string,
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });

  if (res.status === 400 || res.status === 401) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    if (detail?.error === 'invalid_grant') {
      logger.warn('gmail.token.revoked', { userId });
      throw new OAuthRevokedError();
    }
  }

  if (!res.ok) {
    throw new AppError('GMAIL_TOKEN_REFRESH_FAILED', `Google token refresh: ${res.status}`, 502);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new AppError(
      'GMAIL_TOKEN_REFRESH_FAILED',
      'Invalid response from Google token endpoint',
      502,
    );
  }
  return { access_token: json.access_token, expires_in: json.expires_in };
}
