import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from 'react-router-dom';
import { Plus, Trash2, Upload, UserPlus } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useLeads, useDeleteLead, useLeadBulkAction, type LeadsQuery } from '../hooks/useLeads';
import { useLeadList, useLeadLists } from '../hooks/useLeadLists';
import { useQueueLeadsExport } from '../hooks/useExports';
import { Alert, Badge, Button, Card, Input } from '../components/ui';
import { AddLeadModal } from '../components/leads/AddLeadModal';
import { PasteNumbersModal } from '../components/leads/PasteNumbersModal';
import { ImportModal } from '../components/leads/ImportModal';
import { ExportTrigger } from '../components/exports/ExportTrigger';
import { LEAD_STATUSES, type LeadListRow, type LeadStatus } from '@shivanshconnect/shared';
import { ApiClientError } from '../lib/apiClient';

const PAGE_SIZE = 50;
const ROW_HEIGHT = 44;

/**
 * Real server-side pagination (page_size capped at 200 by the backend)
 * is what keeps this page memory-safe for a 10k+-lead org - the browser
 * never holds more than one page of leads at a time. On top of that, the
 * current page's rows are rendered through @tanstack/react-virtual so
 * that a full 200-row page never mounts more DOM nodes than are on
 * screen. With true pagination already bounding memory, virtualizing a
 * ~50-row page is a modest win, but it's cheap and keeps this page
 * consistent if a larger page size is ever chosen later.
 */
export function LeadsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const leadListId = searchParams.get('lead_list_id') ?? undefined;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [dncOnly, setDncOnly] = useState(false);
  const [sortBy, setSortBy] = useState<LeadsQuery['sort_by']>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [showAdd, setShowAdd] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [showImport, setShowImport] = useState(searchParams.get('import') === '1');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  const query: LeadsQuery = {
    page,
    page_size: PAGE_SIZE,
    lead_list_id: leadListId,
    status: status || undefined,
    is_dnc: dncOnly || undefined,
    search: search || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
  };

  const leadsQuery = useLeads(query);
  const listQuery = useLeadList(leadListId);
  const listsQuery = useLeadLists(1, 200);
  const deleteLead = useDeleteLead();
  const bulkAction = useLeadBulkAction();
  const queueExport = useQueueLeadsExport();
  const [actionError, setActionError] = useState<string | null>(null);

  const leads = leadsQuery.data?.data ?? [];
  const pagination = leadsQuery.data?.pagination;

  function resetSelection() {
    setSelected(new Set());
    setSelectAllMatching(false);
  }

  function toggleRow(id: string) {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const allOnPage = leads.every((l) => prev.has(l.id));
      const next = new Set(prev);
      if (allOnPage) leads.forEach((l) => next.delete(l.id));
      else leads.forEach((l) => next.add(l.id));
      return next;
    });
  }

  function invertPage() {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      leads.forEach((l) => (next.has(l.id) ? next.delete(l.id) : next.add(l.id)));
      return next;
    });
  }

  const selectionCount = selectAllMatching ? pagination?.total ?? 0 : selected.size;

  async function runBulkAction(action: 'delete' | 'move_to_list' | 'assign_list', targetListId?: string) {
    setActionError(null);
    try {
      const filter = { lead_list_id: leadListId ?? undefined, status: status || undefined, is_dnc: dncOnly || undefined, search: search || undefined };
      await bulkAction.mutateAsync(
        selectAllMatching
          ? { action, filter, lead_list_id: targetListId }
          : { action, lead_ids: Array.from(selected), lead_list_id: targetListId },
      );
      resetSelection();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : 'Could not complete that action.');
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Leads</h1>
          <p className="mt-1 text-sm text-ink-500">
            {listQuery.data ? `Filtered to "${listQuery.data.name}"` : 'All leads across your organization.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {leadListId && (
            <Button
              variant="secondary"
              onClick={() => {
                searchParams.delete('lead_list_id');
                setSearchParams(searchParams);
              }}
            >
              Clear list filter
            </Button>
          )}
          {hasPermission('leads.import') && leadListId && (
            <Button variant="secondary" onClick={() => setShowImport(true)}>
              <Upload className="h-4 w-4" /> Import
            </Button>
          )}
          {hasPermission('leads.create') && (
            <Button variant="secondary" onClick={() => setShowPaste(true)}>
              <UserPlus className="h-4 w-4" /> Paste numbers
            </Button>
          )}
          {hasPermission('leads.create') && (
            <Button onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4" /> Add lead
            </Button>
          )}
          {hasPermission('leads.view') && (
            <ExportTrigger
              csvType="leads_csv"
              xlsxType="leads_xlsx"
              pending={queueExport.isPending}
              onExport={(type) =>
                queueExport.mutateAsync({
                  type,
                  filters: {
                    lead_list_id: leadListId ?? undefined,
                    status: status || undefined,
                    is_dnc: dncOnly || undefined,
                    search: search || undefined,
                  },
                })
              }
            />
          )}
        </div>
      </div>

      {showAdd && <AddLeadModal leadListId={leadListId} onClose={() => setShowAdd(false)} />}
      {showPaste && <PasteNumbersModal leadListId={leadListId} onClose={() => setShowPaste(false)} />}
      {showImport && leadListId && <ImportModal leadListId={leadListId} onClose={() => setShowImport(false)} />}

      <Card className="mt-6 !p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Input
              placeholder="Search name, phone or email..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm"
            value={leadListId ?? ''}
            onChange={(e) => {
              const next = new URLSearchParams(searchParams);
              if (e.target.value) next.set('lead_list_id', e.target.value);
              else next.delete('lead_list_id');
              setSearchParams(next);
              setPage(1);
            }}
          >
            <option value="">All lists</option>
            {(listsQuery.data?.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as LeadStatus | '');
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-ink-300"
              checked={dncOnly}
              onChange={(e) => {
                setDncOnly(e.target.checked);
                setPage(1);
              }}
            />
            DNC only
          </label>
          <select
            className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm"
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [by, dir] = e.target.value.split(':');
              setSortBy(by as LeadsQuery['sort_by']);
              setSortDir(dir as 'asc' | 'desc');
            }}
          >
            <option value="created_at:desc">Newest first</option>
            <option value="created_at:asc">Oldest first</option>
            <option value="last_name:asc">Last name A-Z</option>
            <option value="attempts:desc">Most attempts</option>
            <option value="next_callback_at:asc">Next callback</option>
          </select>
        </div>
      </Card>

      {selectionCount > 0 && (
        <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 !p-3">
          <div className="flex items-center gap-3 text-sm text-ink-700">
            <span>
              <strong>{selectionCount}</strong> selected
            </span>
            {!selectAllMatching && pagination && pagination.total > leads.length && (
              <button
                type="button"
                className="text-xs font-medium text-gold-700 underline"
                onClick={() => setSelectAllMatching(true)}
              >
                Select all {pagination.total} matching leads
              </button>
            )}
            <button type="button" className="text-xs text-ink-500 underline" onClick={resetSelection}>
              Clear selection
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded-md border border-ink-300 bg-white px-2 py-1.5 text-sm"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) runBulkAction('assign_list', e.target.value);
                e.target.value = '';
              }}
            >
              <option value="">Add to list...</option>
              {(listsQuery.data?.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border border-ink-300 bg-white px-2 py-1.5 text-sm"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) runBulkAction('move_to_list', e.target.value);
                e.target.value = '';
              }}
            >
              <option value="">Move to list...</option>
              {(listsQuery.data?.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {hasPermission('leads.delete') && (
              <Button variant="danger" onClick={() => runBulkAction('delete')} disabled={bulkAction.isPending}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </div>
        </Card>
      )}
      {actionError && (
        <div className="mt-3">
          <Alert>{actionError}</Alert>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3 text-xs text-ink-500">
        <button type="button" className="underline" onClick={togglePage}>
          Select page
        </button>
        <button type="button" className="underline" onClick={invertPage}>
          Invert page selection
        </button>
      </div>

      <LeadsTable
        leads={leads}
        loading={leadsQuery.isLoading}
        selected={selected}
        onToggleRow={toggleRow}
        onDelete={hasPermission('leads.delete') ? (id) => deleteLead.mutate(id) : undefined}
      />

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>
            Page {pagination.page} of {pagination.total_pages} ({pagination.total} leads)
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="secondary" disabled={page >= pagination.total_pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const COLUMNS: { key: string; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'company', label: 'Company' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'list', label: 'List' },
  { key: 'status', label: 'Status' },
  { key: 'last_called_at', label: 'Last Called' },
  { key: 'attempts', label: 'Attempts' },
  { key: 'last_disposition', label: 'Last Disposition' },
  { key: 'next_callback_at', label: 'Next Callback' },
  { key: 'is_dnc', label: 'DNC' },
  { key: 'created_at', label: 'Created At' },
];

function LeadsTable({
  leads,
  loading,
  selected,
  onToggleRow,
  onDelete,
}: {
  leads: LeadListRow[];
  loading: boolean;
  selected: Set<string>;
  onToggleRow: (id: string) => void;
  onDelete?: (id: string) => void;
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: leads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = useMemo(() => rowVirtualizer.getVirtualItems(), [rowVirtualizer, leads]);

  return (
    <Card className="mt-4 overflow-hidden !p-0">
      <div ref={parentRef} className="max-h-[560px] overflow-auto">
        <table className="w-full min-w-[1200px] text-left text-sm">
          <thead className="sticky top-0 z-10 border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
            <tr>
              <th className="w-8 px-3 py-3" />
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-3 py-3 whitespace-nowrap">
                  {c.label}
                </th>
              ))}
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {loading && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={COLUMNS.length + 2}>
                  Loading leads...
                </td>
              </tr>
            )}
            {!loading && leads.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={COLUMNS.length + 2}>
                  No leads match these filters.
                </td>
              </tr>
            )}
            {!loading && virtualItems.length > 0 && virtualItems[0].start > 0 && (
              <tr aria-hidden style={{ height: virtualItems[0].start }}>
                <td colSpan={COLUMNS.length + 2} />
              </tr>
            )}
            {!loading &&
              virtualItems.map((virtualRow) => {
                const lead = leads[virtualRow.index];
                return (
                  <tr key={lead.id} style={{ height: ROW_HEIGHT }}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-ink-300"
                        checked={selected.has(lead.id)}
                        onChange={() => onToggleRow(lead.id)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-ink-900">
                      <Link to={`/leads/${lead.id}`} className="hover:underline">
                        {lead.first_name || lead.last_name ? `${lead.first_name} ${lead.last_name}`.trim() : '—'}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">{lead.company || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-ink-600">{lead.phone_normalized}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">{lead.email || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">{lead.lead_list_name ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Badge tone={lead.status === 'DNC' ? 'danger' : lead.status === 'COMPLETED' ? 'success' : 'neutral'}>
                        {lead.status}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">
                      {lead.last_called_at ? new Date(lead.last_called_at).toLocaleString() : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">{lead.attempts}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">{lead.last_disposition || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">
                      {lead.next_callback_at ? new Date(lead.next_callback_at).toLocaleString() : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {lead.is_dnc ? <Badge tone="danger">DNC</Badge> : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-500">
                      {new Date(lead.created_at).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {onDelete && (
                        <button
                          type="button"
                          className="text-ink-400 hover:text-red-600"
                          onClick={() => onDelete(lead.id)}
                          aria-label="Delete lead"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            {!loading && virtualItems.length > 0 && (
              <tr aria-hidden style={{ height: Math.max(0, rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end) }}>
                <td colSpan={COLUMNS.length + 2} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
