import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AvailableNumber, PhoneNumber, PhoneNumberCapabilities, TelephonyProviderKey } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export interface PhoneNumberFilters {
  provider_key?: TelephonyProviderKey;
  status?: string;
  assigned_agent_id?: string;
}

export function usePhoneNumbers(filters: PhoneNumberFilters = {}) {
  const params = new URLSearchParams({ page: '1', page_size: '100' });
  if (filters.provider_key) params.set('provider_key', filters.provider_key);
  if (filters.status) params.set('status', filters.status);
  if (filters.assigned_agent_id) params.set('assigned_agent_id', filters.assigned_agent_id);

  return useQuery({
    queryKey: ['phone-numbers', filters],
    queryFn: () => api.getPage<PhoneNumber[]>(`/phone-numbers?${params.toString()}`),
  });
}

export function useSyncPhoneNumbers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerKey: TelephonyProviderKey) =>
      api.post<{ created: number; updated: number; skipped_conflicts: number; total_remote: number }>(`/phone-numbers/sync/${providerKey}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }),
  });
}

export interface AvailableNumberSearch {
  provider_key: 'twilio' | 'telnyx';
  country: string;
  area_code?: string;
  contains?: string;
}

export function useSearchAvailableNumbers() {
  return useMutation({
    mutationFn: ({ provider_key, ...query }: AvailableNumberSearch) => {
      const params = new URLSearchParams({ country: query.country });
      if (query.area_code) params.set('area_code', query.area_code);
      if (query.contains) params.set('contains', query.contains);
      return api.get<AvailableNumber[]>(`/phone-numbers/available/${provider_key}?${params.toString()}`);
    },
  });
}

export function usePurchaseNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider_key, phone_number }: { provider_key: 'twilio' | 'telnyx'; phone_number: string }) =>
      api.post<PhoneNumber>(`/phone-numbers/purchase/${provider_key}`, { phone_number }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }),
  });
}

export interface ImportByonInput {
  provider_key: 'byon';
  phone_number: string;
  friendly_name?: string;
  capabilities: PhoneNumberCapabilities;
  sip_trunk_metadata?: { host: string; username: string; password: string };
}

export interface ImportProviderNumberInput {
  provider_key: 'twilio' | 'telnyx';
  provider_number_id: string;
}

export function useImportPhoneNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportByonInput | ImportProviderNumberInput) => api.post<PhoneNumber>('/phone-numbers/import', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }),
  });
}

export function useUpdatePhoneNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: string;
      friendly_name?: string | null;
      status?: 'active' | 'inactive';
      assigned_agent_id?: string | null;
      assigned_campaign_id?: string | null;
    }) => api.patch<PhoneNumber>(`/phone-numbers/${id}`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }),
  });
}

export function useSyncNumberWithVapi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<PhoneNumber>(`/phone-numbers/${id}/sync-vapi`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }),
  });
}

export function useDeletePhoneNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/phone-numbers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }),
  });
}
