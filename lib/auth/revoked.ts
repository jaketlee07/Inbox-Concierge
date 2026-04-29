'use client';

import { useSyncExternalStore } from 'react';

// Module-level flag flipped once when any /api/* response returns 401. The
// AuthError modal subscribes via useAuthRevoked() and renders non-dismissable
// over the app. One-way latch — flipping back to false is intentionally not
// supported; once you've lost the session the only path forward is sign in.
let revoked = false;
const listeners = new Set<() => void>();

export function setAuthRevoked(): void {
  if (revoked) return;
  revoked = true;
  for (const l of listeners) l();
}

export function useAuthRevoked(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => revoked,
    () => false,
  );
}
