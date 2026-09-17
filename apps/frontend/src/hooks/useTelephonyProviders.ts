import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TelephonyProviderKey, TelephonyProviderSummary } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useTelephonyProviders() {
  return useQuery({
    queryKey: ['telephony-providers'],
    queryFn: () => api.get<TelephonyProviderSummary[]>('/phone-number-providers'),
  });
}

export function useSaveTelephonyProviderCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      ...payload
    }: { key: TelephonyProviderKey } & (
      | { account_sid: string; auth_token: string }
      | { api_key: string }
    )) => api.post(`/phone-number-providers/${key}/credentials`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telephony-providers'] }),
  });
}

export function useTestTelephonyProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: TelephonyProviderKey) =>
      api.post<{ success: boolean; status: string; last_error: string | null }>(`/phone-number-providers/${key}/test-connection`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telephony-providers'] }),
  });
}
