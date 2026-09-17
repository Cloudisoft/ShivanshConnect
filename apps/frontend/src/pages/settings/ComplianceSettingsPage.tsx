import { useState, type FormEvent } from 'react';
import { ShieldOff, Trash2 } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useAddDncEntry, useDncEntries, useRemoveDncEntry } from '../../hooks/useDnc';
import { Alert, Badge, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

export function ComplianceSettingsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('leads.edit');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const dncQuery = useDncEntries(page, 50, search || undefined);
  const removeEntry = useRemoveDncEntry();

  const entries = dncQuery.data?.data ?? [];
  const pagination = dncQuery.data?.pagination;

  return (
    <div>
      <h2 className="text-base font-semibold text-ink-900">Do Not Call list</h2>
      <p className="mt-1 text-sm text-ink-500">
        Numbers on this list are suppressed from calling even if they are never imported as a lead. Adding a
        number here also flags any existing matching lead in your organization.
      </p>

      {canEdit && <AddDncForm />}

      <Card className="mt-6 !p-4">
        <Input placeholder="Search by phone number..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </Card>

      <Card className="mt-4 overflow-hidden !p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Scope</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Added</th>
              {canEdit && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {dncQuery.isLoading && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={6}>
                  Loading...
                </td>
              </tr>
            )}
            {!dncQuery.isLoading && entries.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={6}>
                  No numbers on the Do Not Call list yet.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="px-4 py-3 font-mono text-ink-900">{entry.phone_normalized}</td>
                <td className="px-4 py-3">
                  <Badge tone={entry.organization_id ? 'neutral' : 'warning'}>
                    {entry.organization_id ? 'organization' : 'global'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-ink-600">{entry.source}</td>
                <td className="px-4 py-3 text-ink-600">{entry.reason || '—'}</td>
                <td className="px-4 py-3 text-ink-500">{new Date(entry.created_at).toLocaleDateString()}</td>
                {canEdit && (
                  <td className="px-4 py-3 text-right">
                    {entry.organization_id && (
                      <button
                        type="button"
                        className="text-ink-400 hover:text-red-600"
                        onClick={() => removeEntry.mutate(entry.id)}
                        aria-label="Remove from DNC list"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>
            Page {pagination.page} of {pagination.total_pages} ({pagination.total} entries)
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

function AddDncForm(): JSX.Element {
  const addEntry = useAddDncEntry();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    try {
      const result = await addEntry.mutateAsync({ phone, reason: reason || undefined, source: 'manual' });
      setSuccess(
        result.leads_flagged > 0
          ? `Added. ${result.leads_flagged} existing lead${result.leads_flagged === 1 ? '' : 's'} flagged as DNC.`
          : 'Added to the Do Not Call list.',
      );
      setPhone('');
      setReason('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not add this number.');
    }
  }

  return (
    <Card className="mt-4">
      <div className="flex items-center gap-2">
        <ShieldOff className="h-4 w-4 text-ink-500" />
        <h3 className="text-sm font-semibold text-ink-900">Add a number</h3>
      </div>
      <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={handleSubmit}>
        {error && (
          <div className="w-full">
            <Alert>{error}</Alert>
          </div>
        )}
        {success && (
          <div className="w-full">
            <Alert variant="success">{success}</Alert>
          </div>
        )}
        <div className="min-w-[200px]">
          <Label htmlFor="dnc_phone">Phone</Label>
          <Input id="dnc_phone" placeholder="(484) 555-1234" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
        <div className="min-w-[220px] flex-1">
          <Label htmlFor="dnc_reason">Reason (optional)</Label>
          <Input id="dnc_reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button type="submit" disabled={addEntry.isPending}>
          {addEntry.isPending ? 'Adding...' : 'Add to DNC list'}
        </Button>
      </form>
    </Card>
  );
}
