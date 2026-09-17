import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CdrDetail, CdrRow, ExportRecord, ExportType, ExportWithDownload } from '@shivanshconnect/shared';
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

export function useExports(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ['exports', page, pageSize],
    queryFn: () => api.getPage<ExportWithDownload[]>(`/exports?page=${page}&page_size=${pageSize}`),
    refetchInterval: (query) => {
      const rows = query.state.data?.data ?? [];
      return rows.some((r) => r.status === 'pending' || r.status === 'processing') ? 3000 : false;
    },
  });
}

/** Downloads the finished export file as a real browser save, via the
 * authenticated blob client (an <a href> alone can't attach the bearer
 * token). */
export async function downloadExportFile(exportId: string, filename: string): Promise<void> {
  const blob = await api.getBlob(`/exports/${exportId}/download`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function fetchRecordingObjectUrl(callId: string): Promise<string> {
  const blob = await api.getBlob(`/cdr/${callId}/recording/download`);
  return URL.createObjectURL(blob);
}
