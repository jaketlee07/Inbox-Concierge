import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { env } from '../env';
import { AuthError, toErrorResponse } from '../errors';
import { logger } from '../logger';

const PUBLIC_PATHS = new Set(['/', '/login', '/auth/callback']);

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const incomingRequestId = request.headers.get('x-request-id');
  const requestId = incomingRequestId ?? crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  if (!incomingRequestId) {
    requestHeaders.set('x-request-id', requestId);
  }

  let supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.has(pathname);
  const isApi = pathname.startsWith('/api/');

  if (!user && !isPublic) {
    if (isApi) {
      logger.warn('auth.unauthorized', { requestId });
      const { error, statusCode } = toErrorResponse(new AuthError());
      return NextResponse.json(
        { error },
        { status: statusCode, headers: { 'x-request-id': requestId } },
      );
    }

    logger.info('auth.redirect', { requestId });
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    const redirect = NextResponse.redirect(redirectUrl);
    redirect.headers.set('x-request-id', requestId);
    return redirect;
  }

  if (user) {
    logger.info('auth.session.refreshed', { userId: user.id, requestId });
  }

  supabaseResponse.headers.set('x-request-id', requestId);
  return supabaseResponse;
}
