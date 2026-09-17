import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Callback, CallbackStatus } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export interface CallbackFilters {
  status?: CallbackStatus;
  campaign_id?: string;
  lead_id?: string;
  from?: string;
  to?: string;
}

export function useCallbacks(page = 1, pageSize = 50, filters: CallbackFilters = {}) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (filters.status) params.set('status', filters.status);
  if (filters.campaign_id) params.set('campaign_id', filters.campaign_id);
  if (filters.lead_id) params.set('lead_id', filters.lead_id);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  return useQuery({
    queryKey: ['callbacks', page, pageSize, filters],
    queryFn: () => api.getPage<Callback[]>(`/callbacks?${params.toString()}`),
    placeholderData: (prev) => prev,
  });
}

export interface CreateCallbackInput {
  lead_id: string;
  campaign_id?: string | null;
  phone_e164?: string;
  scheduled_at: string;
  timezone?: string;
  reason?: string | null;
  notes?: string | null;
  assigned_to?: string | null;
}

export function useCreateCallback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCallbackInput) => api.post<Callback>('/callbacks', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['callbacks'] }),
  });
}

export function useUpdateCallback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.patch<Callback>(`/callbacks/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['callbacks'] }),
  });
}

export function useCancelCallback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<Callback>(`/callbacks/${id}`, { status: 'cancelled' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['callbacks'] }),
  });
}
