'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/Toast';
import { ApiError } from '@/lib/api/fetch';
import { setAuthRevoked } from '@/lib/auth/revoked';
import { TokenRevokedModal } from '@/components/auth/TokenRevokedModal';

// Any /api/* response that came back 401 trips the token-revoked modal once.
// Hooks throw `ApiError` via `apiFetch`, so this catches both query and
// mutation paths.
function handleApiError(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) {
    setAuthRevoked();
  }
}

export function Providers({ children }: { children: ReactNode }) {
  // useState lazy-init keeps one QueryClient per browser tree without leaking
  // across SSR requests (a top-level `new QueryClient()` would).
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleApiError }),
        mutationCache: new MutationCache({ onError: handleApiError }),
        defaultOptions: {
          queries: {
            // GmailClient already does 3 retries with exponential backoff on
            // 429/5xx. Layering query-level retry on top would multiply for
            // transient flakes. Keep it at 1.
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 60_000,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={300}>
        {children}
        <TokenRevokedModal />
        <Toaster position="top-right" richColors closeButton theme="light" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
