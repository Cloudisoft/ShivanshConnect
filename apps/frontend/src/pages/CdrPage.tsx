import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText, History, Loader2 } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useCdrList, useCreateCdrExport, fetchRecordingObjectUrl, type CdrFilters } from '../hooks/useCdr';
import { useExportHistory } from '../hooks/useExports';
import { useCampaigns } from '../hooks/useCampaigns';
import { useAgents } from '../hooks/useAgents';
import { Badge, Button, Card, Input, Label } from '../components/ui';
import { CallDetailDrawer } from '../components/cdr/CallDetailDrawer';
import { ExportTrigger } from '../components/exports/ExportTrigger';
import { ExportHistoryList } from '../components/exports/ExportHistoryList';
import { ApiClientError } from '../lib/apiClient';
import type { CallStatus } from '@shivanshconnect/shared';

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
  failed: 'danger',
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
export function CdrPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canExport = hasPermission('cdr.export');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<CdrFilters>({});
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

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="cdr_campaign">Campaign</Label>
          <select
            id="cdr_campaign"
            className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            value={filters.campaign_id ?? ''}
            onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, campaign_id: e.target.value || undefined })); }}
          >
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="cdr_agent">AI Agent</Label>
          <select
            id="cdr_agent"
            className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            value={filters.ai_agent_id ?? ''}
            onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, ai_agent_id: e.target.value || undefined })); }}
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="cdr_status">Status</Label>
          <select
            id="cdr_status"
            className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            value={filters.status ?? ''}
            onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: (e.target.value || undefined) as CallStatus | undefined })); }}
          >
            <option value="">All statuses</option>
            {['completed', 'failed', 'transferred', 'dnc', 'cancelled', 'transfer_failed'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="cdr_phone">Phone</Label>
          <Input id="cdr_phone" placeholder="+1..." onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, phone: e.target.value || undefined })); }} />
        </div>
        <div>
          <Label htmlFor="cdr_from">From</Label>
          <Input id="cdr_from" type="date" onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, date_from: e.target.value ? new Date(e.target.value).toISOString() : undefined })); }} />
        </div>
        <div>
          <Label htmlFor="cdr_to">To</Label>
          <Input id="cdr_to" type="date" onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, date_to: e.target.value ? new Date(e.target.value).toISOString() : undefined })); }} />
        </div>
      </div>

      {cdrQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading calls...</p>}

      {!cdrQuery.isLoading && rows.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <FileText className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No calls found</p>
          <p className="mt-1 text-sm text-ink-500">Calls placed through campaigns or manually will show up here.</p>
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
                  <td className="px-4 py-2"><Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge></td>
                  <td className="px-4 py-2 text-ink-700">{row.disposition_name ?? '-'}</td>
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
