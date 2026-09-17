import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentEvaluationSummary, AiAgentImprovement, AiAgentVersion, CallEvaluationState, ImprovementStatus } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

/** Phase 11: GET /calls/:id/evaluation - always resolves to a discriminated
 * state (evaluated/not_evaluated/skipped), never throws for the honest
 * "not evaluated yet" cases since those are 200 responses, not errors. A
 * 403 (viewer lacks agents.manage) is left to React Query's normal error
 * state - the caller renders nothing extra rather than fabricating one. */
export function useCallEvaluation(callId: string | null) {
  return useQuery({
    queryKey: ['calls', callId, 'evaluation'],
    queryFn: () => api.get<CallEvaluationState>(`/calls/${callId}/evaluation`),
    enabled: Boolean(callId),
    retry: false,
  });
}

export function useAgentEvaluationSummary(agentId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['agents', agentId, 'evaluation-summary', days],
    queryFn: () => api.get<AgentEvaluationSummary>(`/agents/${agentId}/evaluation-summary?days=${days}`),
    enabled: Boolean(agentId),
  });
}

export function useAgentImprovementsFiltered(agentId: string | undefined, status?: ImprovementStatus) {
  const params = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['agents', agentId, 'improvements', status ?? 'all'],
    queryFn: () => api.get<AiAgentImprovement[]>(`/agents/${agentId}/improvements${params}`),
    enabled: Boolean(agentId),
  });
}

export function useUpdateAgentImprovementStatus(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'under_review' | 'approved' | 'rejected' }) =>
      api.patch<AiAgentImprovement>(`/agent-improvements/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'improvements'] });
    },
  });
}

export function useApplyAgentImprovement(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ improvement: AiAgentImprovement; draft_version: AiAgentVersion }>(`/agent-improvements/${id}/apply`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'improvements'] });
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'versions'] });
    },
  });
}
