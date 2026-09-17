import { useState, type FormEvent } from 'react';
import { CalendarClock, Plus, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useCallbacks, useCancelCallback, useCreateCallback, useUpdateCallback, type CallbackFilters } from '../hooks/useCallbacks';
import { useLeads } from '../hooks/useLeads';
import { useCampaigns } from '../hooks/useCampaigns';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';
import { CALLBACK_STATUSES, CALLBACK_STATUS_LABELS, type Callback, type CallbackStatus } from '@shivanshconnect/shared';

const STATUS_TONE: Record<CallbackStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  scheduled: 'neutral',
  pending: 'warning',
  calling: 'warning',
  completed: 'success',
  cancelled: 'danger',
  failed: 'danger',
};

/**
 * Phase 8: callback scheduler module (spec sections 17/53). A simple
 * sortable/filterable list view - a full calendar widget is a nice-to-
 * have, not required. Creating/rescheduling a callback here goes through
 * the exact same services/callbackScheduler.ts a tool-call webhook event
 * uses, so a human- and an AI-created callback are indistinguishable.
 */
export function CallbacksPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('callbacks.manage');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [rescheduling, setRescheduling] = useState<Callback | null>(null);
  const [filters, setFilters] = useState<CallbackFilters>({});

  const campaignsQuery = useCampaigns(1, 100);
  const campaigns = campaignsQuery.data?.data ?? [];
  const callbacksQuery = useCallbacks(page, 25, filters);
  const callbacks = callbacksQuery.data?.data ?? [];
  const pagination = callbacksQuery.data?.pagination;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Callbacks</h1>
          <p className="mt-1 text-sm text-ink-500">
            Scheduled follow-up calls - created manually or by the AI mid-call. A due callback overrides normal
            cooldown and is dialed through the same campaign dispatcher as any other lead.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> Schedule callback
          </Button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="cb_status_filter">Status</Label>
          <select
            id="cb_status_filter"
            className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            value={filters.status ?? ''}
            onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: (e.target.value || undefined) as CallbackStatus | undefined })); }}
          >
            <option value="">All statuses</option>
            {CALLBACK_STATUSES.map((s) => (
              <option key={s} value={s}>{CALLBACK_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="cb_campaign_filter">Campaign</Label>
          <select
            id="cb_campaign_filter"
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
          <Label htmlFor="cb_from">From</Label>
          <Input id="cb_from" type="date" onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, from: e.target.value ? new Date(e.target.value).toISOString() : undefined })); }} />
        </div>
        <div>
          <Label htmlFor="cb_to">To</Label>
          <Input id="cb_to" type="date" onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, to: e.target.value ? new Date(e.target.value).toISOString() : undefined })); }} />
        </div>
      </div>

      {showCreate && <CallbackForm onClose={() => setShowCreate(false)} />}
      {rescheduling && <CallbackForm existing={rescheduling} onClose={() => setRescheduling(null)} />}

      {callbacksQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading callbacks...</p>}

      {!callbacksQuery.isLoading && callbacks.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <CalendarClock className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No callbacks scheduled</p>
          <p className="mt-1 text-sm text-ink-500">Callbacks scheduled manually or by the AI mid-call show up here.</p>
        </Card>
      )}

      {callbacks.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-ink-200">
          <table className="min-w-full divide-y divide-ink-200 text-sm">
            <thead className="bg-ink-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2">Scheduled</th>
                <th className="px-4 py-2">Phone</th>
                <th className="px-4 py-2">Assigned to</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Source</th>
                {canManage && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {callbacks.map((cb) => (
                <tr key={cb.id}>
                  <td className="px-4 py-2 text-ink-900">{new Date(cb.scheduled_at).toLocaleString()}</td>
                  <td className="px-4 py-2 font-mono text-ink-700">{cb.phone_e164}</td>
                  <td className="px-4 py-2 text-ink-700">{cb.assigned_to === 'ai' ? 'AI (auto-dial)' : cb.assigned_to ?? '-'}</td>
                  <td className="px-4 py-2 max-w-xs truncate text-ink-700">{cb.reason ?? '-'}</td>
                  <td className="px-4 py-2"><Badge tone={STATUS_TONE[cb.status]}>{CALLBACK_STATUS_LABELS[cb.status]}</Badge></td>
                  <td className="px-4 py-2 text-ink-500">{cb.created_by ? 'Manual' : 'AI'}</td>
                  {canManage && (
                    <td className="px-4 py-2 text-right">
                      {cb.status !== 'completed' && cb.status !== 'cancelled' && cb.status !== 'failed' && (
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" onClick={() => setRescheduling(cb)}>Reschedule</Button>
                          <CancelCallbackButton callback={cb} />
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>Page {pagination.page} of {pagination.total_pages} ({pagination.total} callbacks)</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="secondary" disabled={page >= pagination.total_pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CancelCallbackButton({ callback }: { callback: Callback }): JSX.Element {
  const cancelCallback = useCancelCallback();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button variant="danger" disabled={cancelCallback.isPending} onClick={() => cancelCallback.mutate(callback.id)}>Confirm</Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>Back</Button>
      </div>
    );
  }
  return <Button variant="ghost" onClick={() => setConfirming(true)}>Cancel</Button>;
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CallbackForm({ existing, onClose }: { existing?: Callback; onClose: () => void }): JSX.Element {
  const createCallback = useCreateCallback();
  const updateCallback = useUpdateCallback();
  const [leadSearch, setLeadSearch] = useState('');
  const [leadId, setLeadId] = useState(existing?.lead_id ?? '');
  const [campaignId, setCampaignId] = useState(existing?.campaign_id ?? '');
  const [scheduledAt, setScheduledAt] = useState(existing ? toLocalInputValue(existing.scheduled_at) : '');
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [error, setError] = useState<string | null>(null);

  const leadsQuery = useLeads({ page: 1, page_size: 10, search: leadSearch || undefined });
  const leadOptions = leadsQuery.data?.data ?? [];
  const campaignsQuery = useCampaigns(1, 100);
  const campaigns = campaignsQuery.data?.data ?? [];

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const scheduledIso = new Date(scheduledAt).toISOString();
      if (existing) {
        await updateCallback.mutateAsync({ id: existing.id, scheduled_at: scheduledIso, reason: reason || null });
      } else {
        if (!leadId) throw new Error('Select a lead first.');
        await createCallback.mutateAsync({ lead_id: leadId, campaign_id: campaignId || null, scheduled_at: scheduledIso, reason: reason || null });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : 'Could not save this callback.');
    }
  }

  const pending = createCallback.isPending || updateCallback.isPending;

  return (
    <Card className="relative mt-6">
      <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
        <X className="h-4 w-4" />
      </button>
      <h2 className="text-sm font-semibold text-ink-900">{existing ? 'Reschedule callback' : 'Schedule a callback'}</h2>
      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}

        {!existing && (
          <>
            <div className="max-w-sm">
              <Label htmlFor="cb_lead_search">Lead</Label>
              <Input id="cb_lead_search" placeholder="Search by name or phone..." value={leadSearch} onChange={(e) => setLeadSearch(e.target.value)} />
              {leadSearch && leadOptions.length > 0 && (
                <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-ink-200 bg-white text-sm shadow-sm">
                  {leadOptions.map((l) => (
                    <button
                      type="button"
                      key={l.id}
                      className="block w-full px-3 py-1.5 text-left hover:bg-ink-50"
                      onClick={() => { setLeadId(l.id); setLeadSearch(`${l.first_name} ${l.last_name} - ${l.phone_normalized}`); }}
                    >
                      {l.first_name} {l.last_name} - {l.phone_normalized}
                    </button>
                  ))}
                </div>
              )}
              {leadId && <p className="mt-1 text-xs text-green-700">Lead selected.</p>}
            </div>
            <div className="max-w-sm">
              <Label htmlFor="cb_campaign">Campaign (optional - auto-dial via that campaign when set)</Label>
              <select
                id="cb_campaign"
                className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
              >
                <option value="">No campaign (manual follow-up only)</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="max-w-sm">
          <Label htmlFor="cb_scheduled_at">Scheduled for</Label>
          <Input id="cb_scheduled_at" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required />
        </div>
        <div className="max-w-md">
          <Label htmlFor="cb_reason">Reason / notes</Label>
          <textarea
            id="cb_reason"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={2}
            value={reason ?? ''}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending}>{pending ? 'Saving...' : 'Save callback'}</Button>
      </form>
    </Card>
  );
}
