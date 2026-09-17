import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeadListWithCounts } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useLeadLists(page = 1, pageSize = 50, search?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (search) params.set('search', search);
  return useQuery({
    queryKey: ['lead-lists', page, pageSize, search ?? ''],
    queryFn: () => api.getPage<LeadListWithCounts[]>(`/lead-lists?${params.toString()}`),
  });
}

export function useLeadList(id: string | undefined) {
  return useQuery({
    queryKey: ['lead-lists', id],
    queryFn: () => api.get<LeadListWithCounts>(`/lead-lists/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateLeadList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string | null }) => api.post('/lead-lists', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['lead-lists'] }),
  });
}

export function useUpdateLeadList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; description?: string | null }) =>
      api.patch(`/lead-lists/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['lead-lists'] }),
  });
}

export function useDeleteLeadList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/lead-lists/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead-lists'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}
