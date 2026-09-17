import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KnowledgeBase, KnowledgeDocument } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export function useKnowledgeBases(agentId: string | undefined) {
  const params = new URLSearchParams();
  if (agentId) params.set('agent_id', agentId);
  return useQuery({
    queryKey: ['knowledge-bases', agentId ?? ''],
    queryFn: () => api.get<KnowledgeBase[]>(`/knowledge-bases?${params.toString()}`),
    enabled: Boolean(agentId),
  });
}

export function useCreateKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; agent_id?: string | null }) => api.post<KnowledgeBase>('/knowledge-bases', input),
    onSuccess: (_d, variables) => queryClient.invalidateQueries({ queryKey: ['knowledge-bases', variables.agent_id ?? ''] }),
  });
}

export function useKnowledgeDocuments(kbId: string | undefined) {
  return useQuery({
    queryKey: ['knowledge-bases', kbId, 'documents'],
    queryFn: () => api.get<KnowledgeDocument[]>(`/knowledge-bases/${kbId}/documents`),
    enabled: Boolean(kbId),
    refetchInterval: (query) => {
      const docs = query.state.data as KnowledgeDocument[] | undefined;
      const hasPending = docs?.some((d) => d.status === 'uploaded' || d.status === 'processing');
      return hasPending ? 2000 : false;
    },
  });
}

export function useUploadKnowledgeDocument(kbId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE_URL}/knowledge-bases/${kbId}/documents`, {
        method: 'POST',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        body: formData,
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error?.message ?? 'Upload failed.');
      return body.data as KnowledgeDocument;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-bases', kbId, 'documents'] }),
  });
}

export function useDeleteKnowledgeDocument(kbId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.delete(`/knowledge-bases/${kbId}/documents/${docId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-bases', kbId, 'documents'] }),
  });
}

export function useReprocessKnowledgeDocument(kbId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.post(`/knowledge-bases/${kbId}/documents/${docId}/reprocess`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-bases', kbId, 'documents'] }),
  });
}
