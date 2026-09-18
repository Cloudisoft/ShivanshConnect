/**
 * Phase 14: the unified export layer every module's "Export" button and
 * the Export History page use. `useExportHistory()`/`downloadExportFile`
 * generalize Phase 9's CdrPage-only `useExports`/`downloadExportFile`
 * (useCdr.ts) to every export type via GET /exports's new `type` filter -
 * same shape, same polling behavior, just not CDR-only anymore.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExportRecord, ExportType, ExportWithDownload } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useExportHistory(page = 1, pageSize = 20, type?: ExportType) {
  return useQuery({
    queryKey: ['exports', page, pageSize, type ?? 'all'],
    queryFn: () => api.getPage<ExportWithDownload[]>(`/exports?page=${page}&page_size=${pageSize}${type ? `&type=${type}` : ''}`),
    refetchInterval: (query) => {
      const rows = query.state.data?.data ?? [];
      return rows.some((r) => r.status === 'pending' || r.status === 'processing') ? 3000 : false;
    },
  });
}

/** Downloads the finished export file as a real browser save, via the
 * authenticated blob client (an <a href> alone can't attach the bearer
 * token). Shared by every export type's history row. */
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

/** Shared shape every "queue a new export" mutation follows: POST to
 * `path`, then invalidate every `['exports', ...]` query so the history
 * view (wherever it's shown) picks up the new pending row immediately. */
function useQueueExport<TInput extends Record<string, unknown>>(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => api.post<ExportRecord>(path, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exports'] }),
  });
}

export function useQueueLeadsExport() {
  return useQueueExport<{ type: ExportType; filters?: Record<string, unknown> }>('/leads/export');
}

export function useQueueLeadListExport(leadListId: string) {
  return useQueueExport<{ type: ExportType }>(`/lead-lists/${leadListId}/export`);
}

export function useQueueSmsMessagesExport(campaignId: string) {
  return useQueueExport<{ type: ExportType; filters?: Record<string, unknown> }>(`/sms-campaigns/${campaignId}/messages/export`);
}

export function useQueueEmailMessagesExport(campaignId: string) {
  return useQueueExport<{ type: ExportType; filters?: Record<string, unknown> }>(`/email-campaigns/${campaignId}/messages/export`);
}
