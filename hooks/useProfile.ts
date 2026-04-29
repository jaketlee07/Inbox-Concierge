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

export interface ProfileResponse {
  autoExecuteThreshold: number;
  reviewThreshold: number;
  autopilotPaused: boolean;
}

export interface ProfilePatch {
  autoExecuteThreshold?: number;
  reviewThreshold?: number;
  autopilotPaused?: boolean;
}

interface OptimisticContext {
  prev: ProfileResponse | undefined;
}

async function fetchProfile(): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>('/api/profile');
}

async function patchProfile(input: ProfilePatch): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>('/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function useProfile(userId: string): UseQueryResult<ProfileResponse, Error> {
  return useQuery({
    queryKey: ['profile', userId],
    queryFn: fetchProfile,
    staleTime: 60_000,
  });
}

export function useUpdateProfile(
  userId: string,
): UseMutationResult<ProfileResponse, Error, ProfilePatch, OptimisticContext> {
  const queryClient = useQueryClient();
  return useMutation<ProfileResponse, Error, ProfilePatch, OptimisticContext>({
    mutationFn: patchProfile,
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['profile', userId] });
      const prev = queryClient.getQueryData<ProfileResponse>(['profile', userId]);
      if (prev) {
        queryClient.setQueryData<ProfileResponse>(['profile', userId], {
          ...prev,
          ...(patch.autoExecuteThreshold !== undefined && {
            autoExecuteThreshold: patch.autoExecuteThreshold,
          }),
          ...(patch.reviewThreshold !== undefined && { reviewThreshold: patch.reviewThreshold }),
          ...(patch.autopilotPaused !== undefined && { autopilotPaused: patch.autopilotPaused }),
        });
      }
      return { prev };
    },
    onSuccess: (data) => {
      queryClient.setQueryData<ProfileResponse>(['profile', userId], data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['profile', userId], ctx.prev);
      toast.error(`Couldn't save settings: ${err.message}`);
    },
  });
}
