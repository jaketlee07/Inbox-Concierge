import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { encrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';

const REQUIRED_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
] as const;

function redirectToLogin(request: NextRequest, errorCode: string): NextResponse {
  const url = new URL('/login', request.url);
  url.searchParams.set('error', errorCode);
  return NextResponse.redirect(url);
}

async function fetchGrantedScopes(accessToken: string): Promise<string[] | null> {
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { scope?: string };
    if (typeof body.scope !== 'string') return null;
    return body.scope.split(' ').filter(Boolean);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? undefined;
  const params = request.nextUrl.searchParams;

  if (params.get('error')) {
    logger.warn('auth.callback.provider_error', { requestId });
    return redirectToLogin(request, 'oauth_denied');
  }

  const code = params.get('code');
  if (!code) {
    logger.warn('auth.callback.missing_code', { requestId });
    return redirectToLogin(request, 'exchange_failed');
  }

  const supabase = await createClient();

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data?.session) {
      logger.error('auth.callback.exchange_failed', { requestId }, error ?? undefined);
      return redirectToLogin(request, 'exchange_failed');
    }

    const { session } = data;
    const userId = session.user.id;
    const providerToken = session.provider_token;
    const providerRefreshToken = session.provider_refresh_token;

    if (!providerRefreshToken) {
      logger.warn('auth.callback.no_refresh_token', { userId, requestId });
      await supabase.auth.signOut();
      return redirectToLogin(request, 'no_refresh_token');
    }

    if (!providerToken) {
      logger.warn('auth.callback.no_access_token', { userId, requestId });
      await supabase.auth.signOut();
      return redirectToLogin(request, 'exchange_failed');
    }

    const grantedScopes = await fetchGrantedScopes(providerToken);
    if (!grantedScopes) {
      logger.error('auth.callback.tokeninfo_failed', { userId, requestId });
      await supabase.auth.signOut();
      return redirectToLogin(request, 'callback_failed');
    }

    const granted = new Set(grantedScopes);
    const missing = REQUIRED_GMAIL_SCOPES.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      logger.warn('auth.callback.missing_scopes', { userId, requestId });
      await supabase.auth.signOut();
      return redirectToLogin(request, 'missing_scopes');
    }

    const encryptedRefreshToken = encrypt(providerRefreshToken);
    const encryptedAccessToken = encrypt(providerToken);
    const expiresAt = session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null;

    const admin = createAdminClient();
    const { error: upsertError } = await admin.from('oauth_tokens').upsert(
      {
        user_id: userId,
        provider: 'google',
        refresh_token: encryptedRefreshToken,
        access_token: encryptedAccessToken,
        expires_at: expiresAt,
        scope: grantedScopes.join(' '),
      },
      { onConflict: 'user_id' },
    );

    if (upsertError) {
      logger.error('auth.callback.token_persist_failed', { userId, requestId }, upsertError);
      await supabase.auth.signOut();
      return redirectToLogin(request, 'callback_failed');
    }

    logger.info('auth.callback.success', { userId, requestId });
    return NextResponse.redirect(new URL('/inbox', request.url));
  } catch (err) {
    logger.error('auth.callback.unexpected_error', { requestId }, err);
    try {
      await supabase.auth.signOut();
    } catch {
      // best-effort cleanup
    }
    return redirectToLogin(request, 'callback_failed');
  }
}
