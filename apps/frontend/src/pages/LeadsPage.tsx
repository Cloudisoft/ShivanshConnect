import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from 'react-router-dom';
import { Plus, Trash2, Upload, UserPlus } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useLeads, useDeleteLead, useLeadBulkAction, type LeadsQuery } from '../hooks/useLeads';
import { useLeadList, useLeadLists } from '../hooks/useLeadLists';
import { useQueueLeadsExport } from '../hooks/useExports';
import { Alert, Badge, Button, Card } from '../components/ui';
import { FilterBar, FilterDate, FilterSearch, FilterSelect, dayToIso, hasActiveFilters } from '../components/FilterBar';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { AddLeadModal } from '../components/leads/AddLeadModal';
import { PasteNumbersModal } from '../components/leads/PasteNumbersModal';
import { ImportModal } from '../components/leads/ImportModal';
import { ExportTrigger } from '../components/exports/ExportTrigger';
import { LEAD_STATUSES, type LeadFilter, type LeadListRow, type LeadStatus } from '@shivanshconnect/shared';
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
interface LeadsView {
  search?: string;
  status?: LeadStatus;
  dnc?: 'dnc' | 'not_dnc';
  state?: string;
  called?: 'never' | 'called';
  has_callback?: boolean;
  from_day?: string;
  to_day?: string;
}

export function LeadsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const leadListId = searchParams.get('lead_list_id') ?? undefined;
  const [page, setPage] = useState(1);
  const [view, setView] = useState<LeadsView>({});
  const [sortBy, setSortBy] = useState<LeadsQuery['sort_by']>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [showAdd, setShowAdd] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [showImport, setShowImport] = useState(searchParams.get('import') === '1');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  // ONE filter object for the list, "select all matching" bulk actions
  // and the export - so they always cover exactly the same leads.
  const leadFilter = useMemo<LeadFilter>(
    () => ({
      lead_list_id: leadListId,
      status: view.status,
      is_dnc: view.dnc === undefined ? undefined : view.dnc === 'dnc',
      search: view.search,
      state: view.state,
      called: view.called,
      has_callback: view.has_callback || undefined,
      created_from: dayToIso(view.from_day),
      created_to: dayToIso(view.to_day, true),
    }),
    [leadListId, view],
  );
  const query: LeadsQuery = {
    ...leadFilter,
    lead_list_id: leadListId,
    page,
    page_size: PAGE_SIZE,
    sort_by: sortBy,
    sort_dir: sortDir,
  };

  const leadsQuery = useLeads(query);
  const listQuery = useLeadList(leadListId);
  // page_size is capped at 100 by the backend's shared pagination schema
  // (apps/backend/src/schemas/common.ts) - 200 here silently 422'd on
  // every single load of this page.
  const listsQuery = useLeadLists(1, 100);
  const deleteLead = useDeleteLead();
  const bulkAction = useLeadBulkAction();
  const queueExport = useQueueLeadsExport();
  const [actionError, setActionError] = useState<string | null>(null);

  const leads = leadsQuery.data?.data ?? [];
  const pagination = leadsQuery.data?.pagination;
  const leadsError = leadsQuery.isError
    ? leadsQuery.error instanceof ApiClientError
      ? leadsQuery.error.message
      : 'Could not load leads. Please try again.'
    : null;

  function resetSelection() {
    setSelected(new Set());
    setSelectAllMatching(false);
  }

  // A filter change resets the page and any selection (a selection made
  // under other filters must never ride along into a bulk action).
  function updateView(change: (v: LeadsView) => LeadsView) {
    setView(change);
    setPage(1);
    resetSelection();
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

  const pageAllSelected = selectAllMatching || (leads.length > 0 && leads.every((l) => selected.has(l.id)));

  function togglePage() {
    const unselect = pageAllSelected;
    setSelectAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (unselect) leads.forEach((l) => next.delete(l.id));
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
      await bulkAction.mutateAsync(
        selectAllMatching
          ? { action, filter: leadFilter, lead_list_id: targetListId }
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
          {hasPermission('leads.import') && (
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
                  filters: { ...leadFilter },
                })
              }
            />
          )}
        </div>
      </div>

      {showAdd && <AddLeadModal leadListId={leadListId} onClose={() => setShowAdd(false)} />}
      {showPaste && <PasteNumbersModal leadListId={leadListId} onClose={() => setShowPaste(false)} />}
      {showImport && <ImportModal leadListId={leadListId} onClose={() => setShowImport(false)} />}

      <FilterBar
        active={hasActiveFilters(view) || Boolean(leadListId)}
        onClear={() => {
          updateView(() => ({}));
          if (leadListId) {
            const next = new URLSearchParams(searchParams);
            next.delete('lead_list_id');
            setSearchParams(next);
          }
        }}
      >
        <FilterSearch label="Search" placeholder="Name, phone or email..." value={view.search} onChange={(v) => updateView((f) => ({ ...f, search: v }))} />
        <FilterSelect
          label="List"
          allLabel="All lists"
          value={leadListId}
          onChange={(v) => {
            const next = new URLSearchParams(searchParams);
            if (v) next.set('lead_list_id', v);
            else next.delete('lead_list_id');
            setSearchParams(next);
            setPage(1);
            resetSelection();
          }}
          options={(listsQuery.data?.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
        />
        <FilterSelect label="Status" allLabel="All statuses" value={view.status} onChange={(v) => updateView((f) => ({ ...f, status: v as LeadStatus | undefined }))} options={LEAD_STATUSES.map((st) => ({ value: st, label: st.replace(/_/g, ' ') }))} />
        <FilterSelect
          label="Called"
          allLabel="Any"
          value={view.called}
          onChange={(v) => updateView((f) => ({ ...f, called: v as LeadsView['called'] }))}
          options={[{ value: 'never', label: 'Never called' }, { value: 'called', label: 'Called at least once' }]}
        />
        <FilterSelect
          label="DNC"
          allLabel="Any"
          value={view.dnc}
          onChange={(v) => updateView((f) => ({ ...f, dnc: v as LeadsView['dnc'] }))}
          options={[{ value: 'dnc', label: 'DNC only' }, { value: 'not_dnc', label: 'Not DNC' }]}
        />
        <FilterSearch label="State" placeholder="e.g. PA" value={view.state} onChange={(v) => updateView((f) => ({ ...f, state: v }))} className="w-24" />
        <FilterDate label="Added from" value={view.from_day} onChange={(v) => updateView((f) => ({ ...f, from_day: v }))} />
        <FilterDate label="Added to" value={view.to_day} onChange={(v) => updateView((f) => ({ ...f, to_day: v }))} />
        <label className="mb-2 flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" className="h-4 w-4 rounded border-ink-300" checked={Boolean(view.has_callback)} onChange={(e) => updateView((f) => ({ ...f, has_callback: e.target.checked || undefined }))} />
          Has callback
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-600">
          Sort
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
            <option value="last_called_at:desc">Recently called</option>
            <option value="next_callback_at:asc">Next callback</option>
          </select>
        </label>
      </FilterBar>

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
      {leadsError && (
        <div className="mt-3">
          <Alert>
            Could not load leads: {leadsError}{' '}
            <button type="button" className="underline" onClick={() => leadsQuery.refetch()}>
              Retry
            </button>
          </Alert>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3 text-xs text-ink-500">
        <button type="button" className="underline" onClick={togglePage}>
          {pageAllSelected ? 'Unselect page' : 'Select page'}
        </button>
        <button type="button" className="underline" onClick={invertPage}>
          Invert page selection
        </button>
        {pagination && pagination.total > 0 && !selectAllMatching && (
          <button
            type="button"
            className="font-medium text-gold-700 underline"
            onClick={() => {
              setSelected(new Set(leads.map((l) => l.id)));
              setSelectAllMatching(true);
            }}
          >
            Select all {pagination.total} matching leads
          </button>
        )}
      </div>

      <ErrorBoundary label="Leads table" key={`${page}-${leads.length}-${leadsQuery.dataUpdatedAt}`}>
        <LeadsTable
          leads={leads}
          loading={leadsQuery.isLoading}
          hasError={leadsQuery.isError}
          selected={selected}
          allMatching={selectAllMatching}
          pageAllSelected={pageAllSelected}
          onTogglePage={togglePage}
          onToggleRow={toggleRow}
          onDelete={hasPermission('leads.delete') ? (id) => deleteLead.mutate(id) : undefined}
        />
      </ErrorBoundary>

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
  hasError,
  selected,
  allMatching,
  pageAllSelected,
  onTogglePage,
  onToggleRow,
  onDelete,
}: {
  allMatching: boolean;
  pageAllSelected: boolean;
  onTogglePage: () => void;
  leads: LeadListRow[];
  loading: boolean;
  hasError?: boolean;
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
              <th className="w-8 px-3 py-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-ink-300"
                  checked={pageAllSelected}
                  onChange={onTogglePage}
                  aria-label="Select all leads on this page"
                />
              </th>
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
            {!loading && !hasError && leads.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={COLUMNS.length + 2}>
                  No leads match these filters.
                </td>
              </tr>
            )}
            {!loading && hasError && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={COLUMNS.length + 2}>
                  Leads could not be loaded (see the error above).
                </td>
              </tr>
            )}
            {/* The virtualizer measures the scroll container's size in an
                effect that runs after mount - on a fresh mount (e.g. right
                after navigating here) it can render zero virtual items on
                the very first paint even though `leads` already has real
                rows, since it hasn't measured yet. Without this fallback
                that left the table showing NEITHER the row data NOR the
                "no leads match" message - a real, non-empty result
                rendering as a totally blank table with no error and no
                explanation. Falls back to plain (non-virtualized)
                rendering of every row just for that one frame; the next
                render picks up the virtualizer's real measurement. */}
            {!loading && !hasError && leads.length > 0 && virtualItems.length === 0 && (
              <>
                {leads.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} selected={allMatching || selected.has(lead.id)} onToggleRow={onToggleRow} onDelete={onDelete} />
                ))}
              </>
            )}
            {!loading && virtualItems.length > 0 && virtualItems[0].start > 0 && (
              <tr aria-hidden style={{ height: virtualItems[0].start }}>
                <td colSpan={COLUMNS.length + 2} />
              </tr>
            )}
            {!loading &&
              virtualItems.map((virtualRow) => {
                const lead = leads[virtualRow.index];
                return <LeadRow key={lead.id} lead={lead} selected={allMatching || selected.has(lead.id)} onToggleRow={onToggleRow} onDelete={onDelete} />;
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

function LeadRow({
  lead,
  selected,
  onToggleRow,
  onDelete,
}: {
  lead: LeadListRow;
  selected: boolean;
  onToggleRow: (id: string) => void;
  onDelete?: (id: string) => void;
}): JSX.Element {
  return (
    <tr style={{ height: ROW_HEIGHT }}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-ink-300"
          checked={selected}
          onChange={() => onToggleRow(lead.id)}
        />
      </td>
      <td className="whitespace-nowrap px-3 py-2 font-medium text-ink-900">
        <Link to={`/leads/${lead.id}`} className="hover:underline">
          {lead.first_name || lead.last_name ? `${lead.first_name} ${lead.last_name}`.trim() : '—'}
        </Link>
      </td>
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
      <td className="whitespace-nowrap px-3 py-2">{lead.is_dnc ? <Badge tone="danger">DNC</Badge> : '—'}</td>
      <td className="whitespace-nowrap px-3 py-2 text-ink-500">{new Date(lead.created_at).toLocaleDateString()}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        {onDelete && (
          <button type="button" className="text-ink-400 hover:text-red-600" onClick={() => onDelete(lead.id)} aria-label="Delete lead">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  );
}
