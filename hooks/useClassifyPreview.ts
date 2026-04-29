'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { ClassifiedThread } from '@/lib/claude/parser';

export type ClassifyPreviewResponse = {
  classifications: ClassifiedThread[];
  hydrationFailed: string[];
};

async function classifyPreview(threadIds: string[]): Promise<ClassifyPreviewResponse> {
  const res = await fetch('/api/classify-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadIds }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as ClassifyPreviewResponse;
}

export function useClassifyPreview(): UseMutationResult<ClassifyPreviewResponse, Error, string[]> {
  return useMutation({ mutationFn: classifyPreview });
}
