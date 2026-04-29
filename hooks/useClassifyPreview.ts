'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/fetch';
import type { ClassifiedThread } from '@/lib/claude/parser';
import type { ExecutionResult } from '@/lib/pipeline/executor';

export type ExecutorPreview = {
  threadId: string;
  status: ExecutionResult['status'];
};

export type ClassifyPreviewResponse = {
  classifications: ClassifiedThread[];
  executorResults: ExecutorPreview[];
  hydrationFailed: string[];
};

async function classifyPreview(threadIds: string[]): Promise<ClassifyPreviewResponse> {
  return apiFetch<ClassifyPreviewResponse>('/api/classify-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadIds }),
  });
}

export function useClassifyPreview(): UseMutationResult<ClassifyPreviewResponse, Error, string[]> {
  return useMutation({ mutationFn: classifyPreview });
}
