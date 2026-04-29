'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/Toast';

export function Providers({ children }: { children: ReactNode }) {
  // useState lazy-init keeps one QueryClient per browser tree without leaking
  // across SSR requests (a top-level `new QueryClient()` would).
  const [client] = useState(
    () =>
      new QueryClient({
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
        <Toaster position="top-right" richColors closeButton theme="light" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
