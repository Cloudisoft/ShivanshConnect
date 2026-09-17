import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VoiceProviderKey, VoiceProviderSummary } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useVoiceProviders() {
  return useQuery({
    queryKey: ['voice-providers'],
    queryFn: () => api.get<VoiceProviderSummary[]>('/voice-providers'),
  });
}

export function useSaveVoiceProviderCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      ...payload
    }: { key: VoiceProviderKey } & (
      | { kind: 'api_key'; api_key: string }
      | { kind: 'endpoint'; endpoint_url: string; api_key: string }
    )) => api.post(`/voice-providers/${key}/credentials`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voice-providers'] }),
  });
}

export function useTestVoiceProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: VoiceProviderKey) => api.post<{ success: boolean; status: string; last_error: string | null }>(`/voice-providers/${key}/test-connection`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voice-providers'] }),
  });
}
