import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CdrDetail, CdrRow, ExportRecord, ExportType } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export interface CdrFilters {
  date_from?: string;
  date_to?: string;
  campaign_id?: string;
  ai_agent_id?: string;
  disposition?: string;
  phone?: string;
  lead_id?: string;
  status?: string;
}

function buildParams(page: number, pageSize: number, filters: CdrFilters): URLSearchParams {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params;
}

export function useCdrList(page: number, pageSize: number, filters: CdrFilters = {}) {
  const params = buildParams(page, pageSize, filters);
  return useQuery({
    queryKey: ['cdr', page, pageSize, filters],
    queryFn: () => api.getPage<CdrRow[]>(`/cdr?${params.toString()}`),
    placeholderData: (prev) => prev,
  });
}

export function useCdrDetail(callId: string | null) {
  return useQuery({
    queryKey: ['cdr', 'detail', callId],
    queryFn: () => api.get<CdrDetail>(`/cdr/${callId}`),
    enabled: Boolean(callId),
  });
}

export function useTranscriptSearch(query: string) {
  return useQuery({
    queryKey: ['cdr', 'search-transcript', query],
    queryFn: () => api.getPage<Array<{ call_id: string; transcript_id: string; rank: number; snippet: string }>>(`/cdr/search-transcript?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length > 0,
  });
}

export function useCreateCdrExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: ExportType; filters: CdrFilters }) => api.post<ExportRecord>('/cdr/export', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exports'] }),
  });
}

// Phase 14: general export-history polling and file download moved to
// hooks/useExports.ts (useExportHistory/downloadExportFile), since every
// export type - not just CDR's - shares that exact same shape.

export async function fetchRecordingObjectUrl(callId: string): Promise<string> {
  const blob = await api.getBlob(`/cdr/${callId}/recording/download`);
  return URL.createObjectURL(blob);
}
