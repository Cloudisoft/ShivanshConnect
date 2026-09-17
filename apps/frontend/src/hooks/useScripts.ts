import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Script, ScriptTemplate } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export function useScripts(page = 1, pageSize = 50, agentId?: string, search?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (agentId) params.set('agent_id', agentId);
  if (search) params.set('search', search);
  return useQuery({
    queryKey: ['scripts', page, pageSize, agentId ?? '', search ?? ''],
    queryFn: () => api.getPage<Script[]>(`/scripts?${params.toString()}`),
  });
}

export function useScript(id: string | undefined) {
  return useQuery({
    queryKey: ['scripts', id],
    queryFn: () => api.get<Script>(`/scripts/${id}`),
    enabled: Boolean(id),
  });
}

export function useScriptTemplates() {
  return useQuery({
    queryKey: ['scripts', 'templates'],
    queryFn: () => api.get<ScriptTemplate[]>('/scripts/templates'),
    staleTime: Infinity,
  });
}

export function useCreateScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      content?: string;
      agent_id?: string | null;
      source?: 'editor' | 'template';
      template_key?: string;
    }) => api.post<Script>('/scripts', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scripts'] }),
  });
}

export function useUpdateScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.patch<Script>(`/scripts/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scripts'] }),
  });
}

export function useDeleteScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/scripts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scripts'] }),
  });
}

export function useUploadScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE_URL}/scripts/upload`, {
        method: 'POST',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        body: formData,
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error?.message ?? 'Upload failed.');
      return body.data as Script;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scripts'] }),
  });
}
