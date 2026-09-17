import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Disposition } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useDispositions(page = 1, pageSize = 100) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  return useQuery({
    queryKey: ['dispositions', page, pageSize],
    queryFn: () => api.getPage<Disposition[]>(`/dispositions?${params.toString()}`),
  });
}

export function useCreateDisposition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string; name: string }) => api.post<Disposition>('/dispositions', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispositions'] }),
  });
}

export function useUpdateDisposition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<Disposition>(`/dispositions/${id}`, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispositions'] }),
  });
}

export function useDeleteDisposition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/dispositions/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispositions'] }),
  });
}

export function useOverrideCallDisposition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ callId, dispositionId, reason }: { callId: string; dispositionId: string; reason?: string }) =>
      api.patch(`/calls/${callId}/disposition`, { disposition_id: dispositionId, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['calls'] }),
  });
}
