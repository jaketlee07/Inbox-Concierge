// Typed error class so the global QueryCache/MutationCache onError handler
// in providers.tsx can detect 401 specifically and trigger the
// token-revoked modal. Hooks throw via apiFetch; the cache handlers receive
// these errors with status preserved.
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(
      body.error?.message ?? `Request failed (${res.status})`,
      res.status,
      body.error?.code,
    );
  }
  return (await res.json()) as T;
}
