import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DncEntry } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useDncEntries(page = 1, pageSize = 50, search?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (search) params.set('search', search);
  return useQuery({
    queryKey: ['dnc', page, pageSize, search ?? ''],
    queryFn: () => api.getPage<DncEntry[]>(`/dnc?${params.toString()}`),
    placeholderData: (prev) => prev,
  });
}

export function useAddDncEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { phone: string; reason?: string; source?: 'manual' | 'caller_request' | 'import' }) =>
      api.post<DncEntry & { leads_flagged: number }>('/dnc', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dnc'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

export function useRemoveDncEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/dnc/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dnc'] }),
  });
}
