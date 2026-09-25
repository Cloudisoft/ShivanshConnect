import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Campaign, CampaignCounts, CampaignVersion, DialingSettings, PhoneNumber, PreflightResult } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export type CampaignWithCounts = Campaign & { counts: CampaignCounts };
export type CampaignDetail = Campaign & {
  counts: CampaignCounts;
  current_version: CampaignVersion | null;
  draft_version: CampaignVersion | null;
  phone_numbers: PhoneNumber[];
};

export function useCampaigns(page = 1, pageSize = 50, status?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (status) params.set('status', status);
  return useQuery({
    queryKey: ['campaigns', page, pageSize, status ?? ''],
    queryFn: () => api.getPage<CampaignWithCounts[]>(`/campaigns?${params.toString()}`),
  });
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: ['campaigns', id],
    queryFn: () => api.get<CampaignDetail>(`/campaigns/${id}`),
    enabled: Boolean(id),
    refetchInterval: 5000, // live counts on the Overview tab
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>, id?: string) {
  queryClient.invalidateQueries({ queryKey: ['campaigns'] });
  if (id) queryClient.invalidateQueries({ queryKey: ['campaigns', id] });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<Campaign>('/campaigns', input),
    onSuccess: () => invalidate(queryClient),
  });
}

export function useUpdateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.patch<Campaign>(`/campaigns/${id}`, input),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

// Replaces the campaign's whole phone number dialing pool - saves
// immediately (like the campaign's own direct fields), no publish
// needed, since the dispatcher reads the live pool every tick rather
// than a published-version snapshot.
export function useSetCampaignPhoneNumbers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, phoneNumberIds }: { id: string; phoneNumberIds: string[] }) =>
      api.put<{ phone_number_ids: string[] }>(`/campaigns/${id}/phone-numbers`, { phone_number_ids: phoneNumberIds }),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

export function useDeleteCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/campaigns/${id}`),
    onSuccess: () => invalidate(queryClient),
  });
}

export function useDuplicateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Campaign>(`/campaigns/${id}/duplicate`),
    onSuccess: () => invalidate(queryClient),
  });
}

export function useCampaignLifecycleAction(action: 'start' | 'pause' | 'resume' | 'stop' | 'restart' | 'archive') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Campaign>(`/campaigns/${id}/${action}`),
    onSuccess: (_d, id) => invalidate(queryClient, id),
  });
}

export function useUpdateConcurrency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, concurrency_limit }: { id: string; concurrency_limit: number }) => api.patch<Campaign>(`/campaigns/${id}/concurrency`, { concurrency_limit }),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

export function useCampaignPreflight(id: string | undefined) {
  return useQuery({
    queryKey: ['campaigns', id, 'preflight'],
    queryFn: () => api.get<PreflightResult>(`/campaigns/${id}/preflight`),
    enabled: Boolean(id),
  });
}

export function useCreateCampaignVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.post<CampaignVersion>(`/campaigns/${id}/versions`, input),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

export function usePublishCampaignVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, versionId, acknowledgeStaleAgentDraft }: { id: string; versionId: string; acknowledgeStaleAgentDraft?: boolean }) =>
      api.post(`/campaigns/${id}/versions/${versionId}/publish`, { acknowledge_stale_agent_draft: acknowledgeStaleAgentDraft ?? false }),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

export function useAttachLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; lead_ids?: string[]; lead_list_id?: string }) => api.post<{ attached: number }>(`/campaigns/${id}/leads`, input),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

export interface CampaignLeadRow {
  id: string;
  lead_id: string;
  status: string;
  attempt_count: number;
  last_attempt_at: string | null;
  next_eligible_at: string | null;
  final_disposition: string | null;
  added_at: string;
  leads: { id: string; first_name: string; last_name: string; phone_normalized: string } | null;
}

export function useCampaignLeads(id: string | undefined, page = 1, pageSize = 25, status?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (status) params.set('status', status);
  return useQuery({
    queryKey: ['campaigns', id, 'leads', page, pageSize, status ?? ''],
    queryFn: () => api.getPage<CampaignLeadRow[]>(`/campaigns/${id}/leads?${params.toString()}`),
    enabled: Boolean(id),
  });
}

export interface RotateDecision {
  leadId: string;
  campaignLeadId: string;
  include: boolean;
  reason: string;
}

export function useRemoveLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lead_ids }: { id: string; lead_ids: string[] }) =>
      api.post<{ removed: number; skipped_active: number }>(`/campaigns/${id}/leads/remove`, { lead_ids }),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

export function useRotateLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dry_run }: { id: string; dry_run: boolean }) =>
      api.post<{ rotated: number; excluded: number; dry_run: boolean; decisions: RotateDecision[] }>(`/campaigns/${id}/leads/rotate`, { dry_run }),
    onSuccess: (_d, v) => invalidate(queryClient, v.id),
  });
}

export function useDialingSettings() {
  return useQuery({ queryKey: ['dialing-settings'], queryFn: () => api.get<DialingSettings>('/dialing-settings') });
}

export function useUpdateDialingSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.patch<DialingSettings>('/dialing-settings', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dialing-settings'] }),
  });
}
