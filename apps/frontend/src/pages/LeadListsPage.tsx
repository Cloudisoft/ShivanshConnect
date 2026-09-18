import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import {
  useCreateLeadList,
  useDeleteLeadList,
  useLeadLists,
  useUpdateLeadList,
} from '../hooks/useLeadLists';
import { useQueueLeadListExport } from '../hooks/useExports';
import { Alert, Button, Card, Input, Label } from '../components/ui';
import { ExportTrigger } from '../components/exports/ExportTrigger';
import { ApiClientError } from '../lib/apiClient';
import type { LeadListWithCounts } from '@shivanshconnect/shared';

export function LeadListsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('leads.create');
  const canEdit = hasPermission('leads.edit');
  const canDelete = hasPermission('leads.delete');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<LeadListWithCounts | null>(null);

  const listsQuery = useLeadLists(page);
  const lists = listsQuery.data?.data ?? [];
  const pagination = listsQuery.data?.pagination;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Lead Lists</h1>
          <p className="mt-1 text-sm text-ink-500">
            Group leads for outreach. Open a list to see its leads, or import a CSV/XLSX file into it.
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> New list
          </Button>
        )}
      </div>

      {showCreate && <LeadListForm mode="create" onClose={() => setShowCreate(false)} />}
      {editing && <LeadListForm mode="edit" list={editing} onClose={() => setEditing(null)} />}

      {listsQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading lead lists...</p>}

      {!listsQuery.isLoading && lists.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <ListChecks className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No lead lists yet</p>
          <p className="mt-1 text-sm text-ink-500">Create a list to start importing or adding leads.</p>
        </Card>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {lists.map((list) => (
          <Card key={list.id} className="flex flex-col">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <Link to={`/leads?lead_list_id=${list.id}`} className="truncate text-sm font-semibold text-ink-900 hover:underline">
                  {list.name}
                </Link>
                {list.description && <p className="mt-1 line-clamp-2 text-xs text-ink-500">{list.description}</p>}
              </div>
              <div className="flex flex-shrink-0 gap-1">
                {canEdit && (
                  <Button variant="ghost" onClick={() => setEditing(list)} aria-label="Edit list">
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                {canDelete && <DeleteListButton list={list} />}
              </div>
            </div>
            <p className="mt-3 text-2xl font-semibold text-ink-900">{list.lead_count}</p>
            <p className="text-xs text-ink-500">{list.lead_count === 1 ? 'lead' : 'leads'}</p>
            <div className="mt-4 flex gap-2">
              <Link to={`/leads?lead_list_id=${list.id}`}>
                <Button variant="secondary">View leads</Button>
              </Link>
              {hasPermission('leads.import') && (
                <Link to={`/leads?lead_list_id=${list.id}&import=1`}>
                  <Button variant="secondary">
                    <Upload className="h-4 w-4" /> Import
                  </Button>
                </Link>
              )}
            </div>
            {hasPermission('leads.view') && (
              <div className="mt-3">
                <LeadListExportButton leadListId={list.id} />
              </div>
            )}
          </Card>
        ))}
      </div>

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>
            Page {pagination.page} of {pagination.total_pages} ({pagination.total} lists)
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

function LeadListExportButton({ leadListId }: { leadListId: string }): JSX.Element {
  const queueExport = useQueueLeadListExport(leadListId);
  return (
    <ExportTrigger
      csvType="leads_csv"
      xlsxType="leads_xlsx"
      pending={queueExport.isPending}
      onExport={(type) => queueExport.mutateAsync({ type })}
    />
  );
}

function DeleteListButton({ list }: { list: LeadListWithCounts }): JSX.Element {
  const deleteList = useDeleteLeadList();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="danger"
          disabled={deleteList.isPending}
          onClick={() => deleteList.mutate(list.id)}
        >
          Confirm
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button variant="ghost" onClick={() => setConfirming(true)} aria-label="Delete list">
      <Trash2 className="h-4 w-4 text-red-600" />
    </Button>
  );
}

function LeadListForm({
  mode,
  list,
  onClose,
}: {
  mode: 'create' | 'edit';
  list?: LeadListWithCounts;
  onClose: () => void;
}): JSX.Element {
  const createList = useCreateLeadList();
  const updateList = useUpdateLeadList();
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode === 'create') {
        await createList.mutateAsync({ name, description: description || null });
      } else if (list) {
        await updateList.mutateAsync({ id: list.id, name, description: description || null });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save this list.');
    }
  }

  const pending = createList.isPending || updateList.isPending;

  return (
    <Card className="relative mt-6">
      <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
        <X className="h-4 w-4" />
      </button>
      <h2 className="text-sm font-semibold text-ink-900">{mode === 'create' ? 'New lead list' : 'Rename lead list'}</h2>
      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div className="max-w-sm">
          <Label htmlFor="list_name">Name</Label>
          <Input id="list_name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
        </div>
        <div className="max-w-md">
          <Label htmlFor="list_description">Description (optional)</Label>
          <textarea
            id="list_description"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={2}
            value={description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Save list'}
        </Button>
      </form>
    </Card>
  );
}
