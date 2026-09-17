import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeadBulkActionType, LeadFilter, LeadListRow, LeadStatus, LeadWithLists } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export interface LeadsQuery {
  page: number;
  page_size?: number;
  lead_list_id?: string;
  status?: LeadStatus;
  is_dnc?: boolean;
  search?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}

function toParams(query: LeadsQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('page_size', String(query.page_size ?? 50));
  if (query.lead_list_id) params.set('lead_list_id', query.lead_list_id);
  if (query.status) params.set('status', query.status);
  if (query.is_dnc !== undefined) params.set('is_dnc', String(query.is_dnc));
  if (query.search) params.set('search', query.search);
  if (query.sort_by) params.set('sort_by', query.sort_by);
  if (query.sort_dir) params.set('sort_dir', query.sort_dir);
  return params.toString();
}

export function useLeads(query: LeadsQuery) {
  return useQuery({
    queryKey: ['leads', query],
    queryFn: () => api.getPage<LeadListRow[]>(`/leads?${toParams(query)}`),
    placeholderData: (prev) => prev,
  });
}

export function useLead(id: string | undefined) {
  return useQuery({
    queryKey: ['leads', 'detail', id],
    queryFn: () => api.get<LeadWithLists>(`/leads/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post('/leads', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead-lists'] });
    },
  });
}

export interface BulkAddResultRow {
  input: string;
  status: 'added' | 'duplicate' | 'invalid' | 'dnc';
  reason?: string;
  lead_id?: string;
}
export interface BulkAddResult {
  total: number;
  added: number;
  duplicate: number;
  invalid: number;
  dnc: number;
  results: BulkAddResultRow[];
}

export function useBulkAddLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { lead_list_id?: string | null; raw_text?: string; numbers?: string[] }) =>
      api.post<BulkAddResult>('/leads/bulk', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead-lists'] });
    },
  });
}

export function useUpdateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.patch(`/leads/${id}`, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['leads', 'detail', variables.id] });
    },
  });
}

export function useDeleteLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/leads/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useLeadBulkAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      action: LeadBulkActionType;
      lead_ids?: string[];
      filter?: LeadFilter;
      lead_list_id?: string;
    }) => api.post<{ action: string; affected: number }>('/leads/bulk-actions', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead-lists'] });
    },
  });
}
