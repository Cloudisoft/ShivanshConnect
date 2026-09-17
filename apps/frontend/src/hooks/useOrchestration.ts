import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VapiCredentialSummary, WebhookEvent } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useVapiCredentials() {
  return useQuery({
    queryKey: ['vapi-credentials'],
    queryFn: () => api.get<VapiCredentialSummary>('/vapi/credentials'),
  });
}

export function useSaveVapiCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (api_key: string) => api.post<VapiCredentialSummary>('/vapi/credentials', { api_key }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vapi-credentials'] }),
  });
}

export function useTestVapiConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ success: boolean; status: string; last_error: string | null }>('/vapi/test-connection'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vapi-credentials'] }),
  });
}

export interface WebhookEventFilters {
  provider?: string;
  processing_status?: string;
}

export function useWebhookEvents(filters: WebhookEventFilters = {}) {
  const params = new URLSearchParams({ page: '1', page_size: '50' });
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.processing_status) params.set('processing_status', filters.processing_status);

  return useQuery({
    queryKey: ['webhook-events', filters],
    queryFn: () => api.getPage<WebhookEvent[]>(`/webhook-events?${params.toString()}`),
  });
}

export function useReplayWebhookEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ replayed: boolean; status_code: number }>(`/webhook-events/${id}/replay`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhook-events'] }),
  });
}
