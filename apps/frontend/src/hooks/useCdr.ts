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

// CDR never auto-refreshed at all - a call that started, rang, connected
// or ended while this page was open only ever showed up after a manual
// browser refresh, reported as "not showing activity in real time".
// Poll on a modest 10s interval (page 1 only - once a user has paged
// past the newest rows, refetching underneath them would shift their
// place) so new/updated calls appear on their own, same pattern already
// used for Campaigns/Messaging's live counts.
export function useCdrList(page: number, pageSize: number, filters: CdrFilters = {}) {
  const params = buildParams(page, pageSize, filters);
  return useQuery({
    queryKey: ['cdr', page, pageSize, filters],
    queryFn: () => api.getPage<CdrRow[]>(`/cdr?${params.toString()}`),
    placeholderData: (prev) => prev,
    refetchInterval: page === 1 ? 10_000 : false,
  });
}

const CALL_TERMINAL_STATUSES = new Set(['completed', 'failed', 'dnc', 'cancelled', 'transferred']);

/** True while any part of this call's record could still change on its
 * own without the viewer doing anything - the call itself hasn't reached
 * a terminal status yet, or its transcript/recording is still being
 * generated/uploaded in the background. */
function isCdrDetailStillSettling(detail: CdrDetail): boolean {
  if (!CALL_TERMINAL_STATUSES.has(detail.status)) return true;
  if (detail.transcript && detail.transcript.status === 'pending') return true;
  if (detail.recording && (detail.recording.status === 'pending' || detail.recording.status === 'downloading')) return true;
  if (detail.has_summary && !detail.summary) return true;
  return false;
}

export function useCdrDetail(callId: string | null) {
  return useQuery({
    queryKey: ['cdr', 'detail', callId],
    queryFn: () => api.get<CdrDetail>(`/cdr/${callId}`),
    enabled: Boolean(callId),
    // The call detail drawer fetched once and never again - opening it
    // mid-call, or right after one ended while the transcript/recording
    // were still being processed, showed permanently incomplete data
    // unless the viewer closed and reopened it themselves, reported as
    // "transcripts or anything are not loading fast" (they weren't slow,
    // they were stuck - nothing ever asked the server again). Polls
    // every 5s only while something could still change, and stops on
    // its own once the call and its artifacts have all settled.
    refetchInterval: (query) => (query.state.data && !isCdrDetailStillSettling(query.state.data) ? false : 5_000),
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
