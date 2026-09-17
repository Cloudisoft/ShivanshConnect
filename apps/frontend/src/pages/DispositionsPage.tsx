import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useCreateDisposition, useDeleteDisposition, useDispositions, useUpdateDisposition } from '../hooks/useDispositions';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';
import type { Disposition } from '@shivanshconnect/shared';

/**
 * Phase 8: dispositions module (spec section 20). System defaults are
 * shown read-only (they are the deterministic engine's own vocabulary -
 * see apps/backend/src/services/dispositionEngine.ts); an org can define
 * its own custom dispositions on top for manual-override/reporting use.
 */
export function DispositionsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('campaigns.edit');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Disposition | null>(null);

  const dispositionsQuery = useDispositions();
  const dispositions = dispositionsQuery.data?.data ?? [];
  const systemDispositions = dispositions.filter((d) => d.is_system);
  const customDispositions = dispositions.filter((d) => !d.is_system);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Dispositions</h1>
          <p className="mt-1 text-sm text-ink-500">
            The deterministic outcome the system assigns to every completed call. System defaults are fixed and
            read-only; add your own custom dispositions for reporting or manual overrides.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> New disposition
          </Button>
        )}
      </div>

      {showCreate && <DispositionForm onClose={() => setShowCreate(false)} />}
      {editing && <DispositionForm disposition={editing} onClose={() => setEditing(null)} />}

      {dispositionsQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading dispositions...</p>}

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink-700">System defaults</h2>
        <p className="mt-1 text-xs text-ink-500">Assigned automatically by the disposition engine. Read-only.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {systemDispositions.map((d) => (
            <Card key={d.id} className="flex items-center justify-between gap-2 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-900">{d.name}</p>
                <p className="truncate font-mono text-xs text-ink-400">{d.code}</p>
              </div>
              <Badge tone="neutral">System</Badge>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink-700">Custom dispositions</h2>
        {customDispositions.length === 0 ? (
          <Card className="mt-3 flex flex-col items-center justify-center py-12 text-center">
            <Tag className="h-8 w-8 text-ink-300" />
            <p className="mt-3 text-sm font-medium text-ink-700">No custom dispositions yet</p>
            <p className="mt-1 text-sm text-ink-500">Add one for outcomes your team wants to track separately.</p>
          </Card>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {customDispositions.map((d) => (
              <Card key={d.id} className="flex items-center justify-between gap-2 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{d.name}</p>
                  <p className="truncate font-mono text-xs text-ink-400">{d.code}</p>
                </div>
                {canManage && (
                  <div className="flex flex-shrink-0 gap-1">
                    <Button variant="ghost" onClick={() => setEditing(d)} aria-label="Edit disposition">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <DeleteDispositionButton disposition={d} />
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function DeleteDispositionButton({ disposition }: { disposition: Disposition }): JSX.Element {
  const deleteDisposition = useDeleteDisposition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="danger"
          disabled={deleteDisposition.isPending}
          onClick={() =>
            deleteDisposition.mutate(disposition.id, {
              onError: (err) => setError(err instanceof ApiClientError ? err.message : 'Could not delete this disposition.'),
            })
          }
        >
          Confirm
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  return (
    <Button variant="ghost" onClick={() => setConfirming(true)} aria-label="Delete disposition">
      <Trash2 className="h-4 w-4 text-red-600" />
    </Button>
  );
}

function DispositionForm({ disposition, onClose }: { disposition?: Disposition; onClose: () => void }): JSX.Element {
  const createDisposition = useCreateDisposition();
  const updateDisposition = useUpdateDisposition();
  const [code, setCode] = useState(disposition?.code ?? '');
  const [name, setName] = useState(disposition?.name ?? '');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (disposition) {
        await updateDisposition.mutateAsync({ id: disposition.id, name });
      } else {
        await createDisposition.mutateAsync({ code: code.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_'), name });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save this disposition.');
    }
  }

  const pending = createDisposition.isPending || updateDisposition.isPending;

  return (
    <Card className="relative mt-6">
      <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
        <X className="h-4 w-4" />
      </button>
      <h2 className="text-sm font-semibold text-ink-900">{disposition ? 'Edit disposition' : 'New custom disposition'}</h2>
      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div className="max-w-sm">
          <Label htmlFor="disposition_name">Name</Label>
          <Input id="disposition_name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
        </div>
        {!disposition && (
          <div className="max-w-sm">
            <Label htmlFor="disposition_code">Code</Label>
            <Input
              id="disposition_code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. CALLBACK_REQUESTED"
              required
              minLength={1}
            />
            <p className="mt-1 text-xs text-ink-500">Uppercase letters, digits and underscores only - shown normalized on save.</p>
          </div>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Save disposition'}
        </Button>
      </form>
    </Card>
  );
}
