import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText, History, Loader2 } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useCdrList, useCreateCdrExport, fetchRecordingObjectUrl, type CdrFilters } from '../hooks/useCdr';
import { useExportHistory } from '../hooks/useExports';
import { useCampaigns } from '../hooks/useCampaigns';
import { useAgents } from '../hooks/useAgents';
import { useDispositions } from '../hooks/useDispositions';
import { FilterBar, FilterDate, FilterSearch, FilterSelect, dayToIso, hasActiveFilters } from '../components/FilterBar';
import { Badge, Button, Card } from '../components/ui';
import { CallDetailDrawer } from '../components/cdr/CallDetailDrawer';
import { ExportTrigger } from '../components/exports/ExportTrigger';
import { ExportHistoryList } from '../components/exports/ExportHistoryList';
import { ApiClientError } from '../lib/apiClient';
import { CALL_STATUSES, dispositionTone, callStatusLabel } from '@shivanshconnect/shared';

/** Direct one-click download straight from the list row, no need to open
 * the detail drawer first. The backend route requires an Authorization
 * header (see hooks/useCdr.ts's fetchRecordingObjectUrl), so this can't
 * be a plain <a href> - fetches the real audio bytes as a blob, then
 * triggers a save-as via a throwaway anchor, exactly the same download
 * mechanism the drawer's own recording player already uses. */
function DownloadRecordingButton({ callId }: { callId: string }): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    setLoading(true);
    setError(null);
    try {
      const objectUrl = await fetchRecordingObjectUrl(callId);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `call-${callId}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not download this recording.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1" title={error ?? 'Download recording'}>
      <button type="button" onClick={handleDownload} disabled={loading} className="text-ink-500 hover:text-ink-900 disabled:opacity-50">
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      </button>
      {error && <span className="text-red-600">!</span>}
    </span>
  );
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  completed: 'success',
  transferred: 'success',
  // 'failed' displays as "No Answer" (callStatusLabel) - neutral, not red,
  // since it's not being shown as a failure any more.
  failed: 'neutral',
  dnc: 'danger',
  cancelled: 'neutral',
};

/**
 * Phase 9: the real CDR module (spec sections 21/22/23), replacing the
 * "scheduled for a later build phase" placeholder. Server-paginated,
 * filterable list; row click opens the full detail drawer (transcript/
 * recording/summary); an export button queues a real background job and
 * a small history panel tracks it to completion.
 */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type CdrView = Omit<CdrFilters, 'date_from' | 'date_to'> & { from_day?: string; to_day?: string };

export function CdrPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canExport = hasPermission('cdr.export');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<CdrView>({});
  const updateView = useCallback((change: (v: CdrView) => CdrView) => {
    setPage(1);
    setView(change);
  }, []);
  const filters = useMemo<CdrFilters>(() => {
    const { from_day, to_day, ...rest } = view;
    return { ...rest, date_from: dayToIso(from_day), date_to: dayToIso(to_day, true) };
  }, [view]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedCallId, setSelectedCallId] = useState<string | null>(() => searchParams.get('call'));
  const [showExportHistory, setShowExportHistory] = useState(false);

  // Deep-link support (Phase 11): the Improvements tab's evidence links
  // land here as /cdr?call=<id>, opening that call's detail drawer
  // directly rather than requiring the person to find it in the list.
  useEffect(() => {
    const fromUrl = searchParams.get('call');
    if (fromUrl && fromUrl !== selectedCallId) setSelectedCallId(fromUrl);
  }, [searchParams, selectedCallId]);

  function closeDrawer() {
    setSelectedCallId(null);
    if (searchParams.get('call')) {
      const next = new URLSearchParams(searchParams);
      next.delete('call');
      setSearchParams(next, { replace: true });
    }
  }

  const campaignsQuery = useCampaigns(1, 100);
  const campaigns = campaignsQuery.data?.data ?? [];
  const agentsQuery = useAgents(1, 100);
  const agents = agentsQuery.data?.data ?? [];
  const dispositionsQuery = useDispositions(1, 100);
  const dispositions = dispositionsQuery.data?.data ?? [];

  const cdrQuery = useCdrList(page, 25, filters);
  const rows = cdrQuery.data?.data ?? [];
  const pagination = cdrQuery.data?.pagination;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">CDR</h1>
          <p className="mt-1 text-sm text-ink-500">
            Every call this organization has placed - real recordings, transcripts and AI summaries once each call's
            artifacts are ingested.
          </p>
        </div>
        {canExport && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowExportHistory(true)}>
              <History className="h-4 w-4" /> Export history
            </Button>
            <ExportButton filters={filters} />
          </div>
        )}
      </div>

      <FilterBar active={hasActiveFilters(view)} onClear={() => updateView(() => ({}))}>
        <FilterSearch label="Phone" placeholder="Number contains..." value={view.phone} onChange={(v) => updateView((f) => ({ ...f, phone: v }))} className="min-w-[160px]" />
        <FilterSelect label="Campaign" allLabel="All campaigns" value={view.campaign_id} onChange={(v) => updateView((f) => ({ ...f, campaign_id: v }))} options={campaigns.map((c) => ({ value: c.id, label: c.name }))} />
        <FilterSelect label="AI Agent" allLabel="All agents" value={view.ai_agent_id} onChange={(v) => updateView((f) => ({ ...f, ai_agent_id: v }))} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
        <FilterSelect label="Direction" allLabel="Inbound & outbound" value={view.direction} onChange={(v) => updateView((f) => ({ ...f, direction: v }))} options={[{ value: 'outbound', label: 'Outbound' }, { value: 'inbound', label: 'Inbound' }]} />
        <FilterSelect label="Status" allLabel="All statuses" value={view.status} onChange={(v) => updateView((f) => ({ ...f, status: v }))} options={CALL_STATUSES.map((st) => ({ value: st, label: sentenceCase(callStatusLabel(st)) }))} />
        <FilterSelect label="Disposition" allLabel="All dispositions" value={view.disposition} onChange={(v) => updateView((f) => ({ ...f, disposition: v }))} options={dispositions.map((d) => ({ value: d.code, label: d.name }))} />
        <FilterSelect
          label="Talk time"
          allLabel="Any length"
          value={view.min_talk_seconds}
          onChange={(v) => updateView((f) => ({ ...f, min_talk_seconds: v }))}
          options={[{ value: '1', label: 'Connected (any talk)' }, { value: '30', label: '30 sec or more' }, { value: '60', label: '1 min or more' }, { value: '180', label: '3 min or more' }]}
        />
        <FilterDate label="From" value={view.from_day} onChange={(v) => updateView((f) => ({ ...f, from_day: v }))} />
        <FilterDate label="To" value={view.to_day} onChange={(v) => updateView((f) => ({ ...f, to_day: v }))} />
      </FilterBar>

      {cdrQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading calls...</p>}

      {!cdrQuery.isLoading && rows.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <FileText className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">{hasActiveFilters(view) ? 'No calls match these filters' : 'No calls found'}</p>
          <p className="mt-1 text-sm text-ink-500">
            {hasActiveFilters(view) ? 'Try widening the dates or clearing a filter.' : 'Calls placed through campaigns or manually will show up here.'}
          </p>
        </Card>
      )}

      {rows.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-ink-200">
          <table className="min-w-full divide-y divide-ink-200 text-sm">
            <thead className="bg-ink-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Ended</th>
                <th className="px-4 py-2">Lead</th>
                <th className="px-4 py-2">Destination</th>
                <th className="px-4 py-2">Campaign</th>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Disposition</th>
                <th className="px-4 py-2">Artifacts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((row) => (
                <tr key={row.call_id} className="cursor-pointer hover:bg-ink-50" onClick={() => setSelectedCallId(row.call_id)}>
                  <td className="px-4 py-2 text-ink-900">{row.started_at ? new Date(row.started_at).toLocaleString() : '-'}</td>
                  <td className="px-4 py-2 text-ink-900">{row.ended_at ? new Date(row.ended_at).toLocaleString() : '-'}</td>
                  <td className="px-4 py-2 text-ink-700">{row.lead_name ?? '-'}</td>
                  <td className="px-4 py-2 font-mono text-ink-700">{row.destination_number}</td>
                  <td className="px-4 py-2 text-ink-700">{row.campaign_name ?? '-'}</td>
                  <td className="px-4 py-2 text-ink-700">{row.ai_agent_name ?? '-'}</td>
                  <td className="px-4 py-2 text-ink-700">{row.duration_seconds != null ? `${row.duration_seconds}s` : '-'}</td>
                  <td className="px-4 py-2"><Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{callStatusLabel(row.status)}</Badge></td>
                  <td className="px-4 py-2">
                    {row.disposition_name ? <Badge tone={dispositionTone(row.disposition_code ?? '')}>{row.disposition_name}</Badge> : <span className="text-ink-700">-</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-500">
                    <div className="flex items-center gap-2">
                      <span>{[row.has_transcript && 'Transcript', row.has_recording && 'Recording', row.has_summary && 'Summary'].filter(Boolean).join(', ') || '-'}</span>
                      {row.has_recording && <DownloadRecordingButton callId={row.call_id} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>Page {pagination.page} of {pagination.total_pages} ({pagination.total} calls)</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="secondary" disabled={page >= pagination.total_pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {selectedCallId && <CallDetailDrawer callId={selectedCallId} onClose={closeDrawer} />}
      {showExportHistory && <ExportHistoryModal onClose={() => setShowExportHistory(false)} />}
    </div>
  );
}

function ExportButton({ filters }: { filters: CdrFilters }): JSX.Element {
  const createExport = useCreateCdrExport();
  return (
    <ExportTrigger
      csvType="cdr_csv"
      xlsxType="cdr_xlsx"
      pending={createExport.isPending}
      onExport={(type) => createExport.mutateAsync({ type, filters })}
    />
  );
}

function ExportHistoryModal({ onClose }: { onClose: () => void }): JSX.Element {
  const exportsQuery = useExportHistory(1, 20);
  const exportsList = exportsQuery.data?.data ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <Card className="max-h-[80vh] w-full max-w-lg overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-ink-900">Export history</h2>
        <div className="mt-4">
          <ExportHistoryList exports={exportsList} />
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </Card>
    </div>
  );
}
