'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { toast } from '@/components/ui/Toast';
import { apiFetch } from '@/lib/api/fetch';

export type DefaultAction = 'archive' | 'label' | null;

export interface BucketView {
  id: string;
  name: string;
  description: string;
  color: string;
  defaultAction: DefaultAction;
  sortOrder: number;
  isSystem: boolean;
  threadCount: number;
}

export interface BucketsResponse {
  buckets: BucketView[];
}

interface CreateVars {
  name: string;
}

interface DeleteVars {
  id: string;
  reassignToBucketName: string;
}

async function fetchBuckets(): Promise<BucketsResponse> {
  return apiFetch<BucketsResponse>('/api/buckets');
}

async function createBucket(input: CreateVars): Promise<BucketView> {
  const data = await apiFetch<{ bucket: BucketView }>('/api/buckets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.bucket;
}

async function deleteBucket(input: DeleteVars): Promise<void> {
  await apiFetch<unknown>(`/api/buckets/${encodeURIComponent(input.id)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reassignToBucketName: input.reassignToBucketName }),
  });
}

export function useBuckets(userId: string): UseQueryResult<BucketsResponse, Error> {
  return useQuery({
    queryKey: ['buckets', userId],
    queryFn: fetchBuckets,
    staleTime: 60_000,
  });
}

export function useCreateBucket(userId: string): UseMutationResult<BucketView, Error, CreateVars> {
  const queryClient = useQueryClient();
  return useMutation<BucketView, Error, CreateVars>({
    mutationFn: createBucket,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buckets', userId] });
    },
    onError: (err) => {
      toast.error(`Couldn't create bucket: ${err.message}`);
    },
  });
}

export function useDeleteBucket(userId: string): UseMutationResult<void, Error, DeleteVars> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteVars>({
    mutationFn: deleteBucket,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buckets', userId] });
      queryClient.invalidateQueries({ queryKey: ['threads', userId] });
      queryClient.invalidateQueries({ queryKey: ['stats', userId] });
    },
    onError: (err) => {
      toast.error(`Couldn't delete bucket: ${err.message}`);
    },
  });
}
