import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentPreviewRequest,
  AgentPreviewResponse,
  AgentRole,
  AiAgent,
  AiAgentImprovement,
  AiAgentVersion,
  AiAgentWithCurrentVersion,
  KnowledgeChunkSearchResult,
} from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useAgents(page = 1, pageSize = 50, search?: string, status?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  return useQuery({
    queryKey: ['agents', page, pageSize, search ?? '', status ?? ''],
    queryFn: () => api.getPage<AiAgent[]>(`/agents?${params.toString()}`),
  });
}

export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: ['agents', id],
    queryFn: () => api.get<AiAgentWithCurrentVersion>(`/agents/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string | null; role: AgentRole }) =>
      api.post<AiAgent>('/agents', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useUpdateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.patch(`/agents/${id}`, input),
    onSuccess: (_d, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agents', variables.id] });
    },
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/agents/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useAgentVersions(agentId: string | undefined) {
  return useQuery({
    queryKey: ['agents', agentId, 'versions'],
    queryFn: () => api.get<AiAgentVersion[]>(`/agents/${agentId}/versions`),
    enabled: Boolean(agentId),
  });
}

export function useCreateAgentVersion(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<AiAgentVersion>(`/agents/${agentId}/versions`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'versions'] });
      queryClient.invalidateQueries({ queryKey: ['agents', agentId] });
    },
  });
}

export function useUpdateAgentVersion(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ versionId, ...input }: { versionId: string } & Record<string, unknown>) =>
      api.patch<AiAgentVersion>(`/agents/${agentId}/versions/${versionId}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'versions'] });
      queryClient.invalidateQueries({ queryKey: ['agents', agentId] });
    },
  });
}

export function usePublishAgentVersion(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      // vapi_sync_error isn't a real column - publish itself always
      // succeeds even when syncing the new config to Vapi fails, so this
      // is the only way the caller can tell that happened (see
      // routes/agents.ts's publish handler).
      api.post<AiAgentVersion & { vapi_sync_error: string | null }>(`/agents/${agentId}/versions/${versionId}/publish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'versions'] });
      queryClient.invalidateQueries({ queryKey: ['agents', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useRestoreAgentVersion(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => api.post<AiAgentVersion>(`/agents/${agentId}/versions/${versionId}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'versions'] });
      queryClient.invalidateQueries({ queryKey: ['agents', agentId] });
    },
  });
}

export function useDeleteAgentVersion(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => api.delete<{ deleted: boolean }>(`/agents/${agentId}/versions/${versionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'versions'] });
      queryClient.invalidateQueries({ queryKey: ['agents', agentId] });
    },
  });
}

export function useAgentImprovements(agentId: string | undefined) {
  return useQuery({
    queryKey: ['agents', agentId, 'improvements'],
    queryFn: () => api.get<AiAgentImprovement[]>(`/agents/${agentId}/improvements`),
    enabled: Boolean(agentId),
  });
}

export function useAgentPreview(agentId: string | undefined) {
  return useMutation({
    mutationFn: (input: AgentPreviewRequest) => api.post<AgentPreviewResponse>(`/agents/${agentId}/preview`, input),
  });
}

export function useAgentKnowledgeSearch(agentId: string | undefined) {
  return useMutation({
    mutationFn: (input: { query: string; top_k?: number }) =>
      api.post<KnowledgeChunkSearchResult[]>(`/agents/${agentId}/knowledge/search`, input),
  });
}
