import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Voice, VoiceProviderKey } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export interface VoiceFilters {
  provider_key?: VoiceProviderKey;
  language?: string;
  gender?: string;
  status?: string;
  is_cloned?: 'true' | 'false';
  search?: string;
}

export function useVoices(filters: VoiceFilters = {}, page = 1) {
  const params = new URLSearchParams({ page: String(page), page_size: '100' });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);

  return useQuery({
    queryKey: ['voices', filters, page],
    queryFn: () => api.getPage<Voice[]>(`/voices?${params.toString()}`),
    placeholderData: (prev) => prev,
  });
}

/** Same voice list, but polls while any voice is still cloning
 * (pending/processing) - used by the cloning flow's status view. */
export function useVoicesWithClonePolling() {
  return useQuery({
    queryKey: ['voices', 'clone-poll'],
    queryFn: () => api.getPage<Voice[]>('/voices?page=1&page_size=100&is_cloned=true'),
    refetchInterval: (query) => {
      const data = query.state.data as { data: Voice[] } | undefined;
      const hasPending = data?.data?.some((v) => v.clone_status === 'pending' || v.clone_status === 'processing');
      return hasPending ? 2000 : false;
    },
  });
}

export function useSyncVoices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerKey: VoiceProviderKey) => api.post<{ created: number; updated: number; total_remote: number }>(`/voices/sync/${providerKey}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voices'] }),
  });
}

export function useImportVoicesById() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider_key: VoiceProviderKey; voices: { provider_voice_id: string; name: string }[]; is_cloned?: boolean }) =>
      api.post<{ created: number; updated: number; failed: { provider_voice_id: string; name: string; error: string }[] }>(
        '/voices/import-by-id',
        input,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voices'] }),
  });
}

export function usePreviewVoice() {
  return useMutation({
    mutationFn: ({ id, sampleText }: { id: string; sampleText?: string }) =>
      api.post<{ url: string; content_type: string }>(`/voices/${id}/preview`, sampleText ? { sample_text: sampleText } : {}),
  });
}

export function useUpdateVoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; is_cloned?: boolean }) => api.patch<Voice>(`/voices/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voices'] }),
  });
}

export function useDeleteVoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/voices/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voices'] }),
  });
}

/** Explicit ids, or every voice matching the list filters. */
export type VoiceSelection = { voice_ids: string[] } | { filter: Record<string, unknown> };

/** The list filters in the JSON shape the bulk endpoints take. */
export function voiceFilterBody(filters: VoiceFilters): Record<string, unknown> {
  const { is_cloned, ...rest } = filters;
  return { ...rest, ...(is_cloned ? { is_cloned: is_cloned === 'true' } : {}) };
}

export function useBulkDeleteVoices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (selection: VoiceSelection) => api.post<{ action: 'delete'; affected: number }>('/voices/bulk-delete', selection),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voices'] }),
  });
}

export function useBulkUpdateVoices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: VoiceSelection & { is_cloned: boolean }) => api.post<{ affected: number }>('/voices/bulk-update', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voices'] }),
  });
}

export function useVoice(id: string | undefined) {
  return useQuery({
    queryKey: ['voices', 'one', id],
    queryFn: () => api.get<Voice>(`/voices/${id}`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export interface CloneVoiceInput {
  provider_key: VoiceProviderKey;
  name: string;
  description?: string;
  language?: string;
  accent?: string;
  gender?: string;
  consent_confirmed: boolean;
  sample: File;
}

export function useCloneVoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CloneVoiceInput) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const formData = new FormData();
      formData.append('provider_key', input.provider_key);
      formData.append('name', input.name);
      if (input.description) formData.append('description', input.description);
      if (input.language) formData.append('language', input.language);
      if (input.accent) formData.append('accent', input.accent);
      if (input.gender) formData.append('gender', input.gender);
      formData.append('consent_confirmed', String(input.consent_confirmed));
      formData.append('sample', input.sample);

      const res = await fetch(`${API_BASE_URL}/voices/clone`, {
        method: 'POST',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        body: formData,
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error?.message ?? 'Voice cloning failed.');
      return body.data as Voice;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['voices'] }),
  });
}
