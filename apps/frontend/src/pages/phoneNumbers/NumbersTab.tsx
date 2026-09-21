import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { TELEPHONY_PROVIDER_LABELS, type PhoneNumber, type TelephonyProviderKey } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import { useAgents } from '../../hooks/useAgents';
import { useTelephonyProviders } from '../../hooks/useTelephonyProviders';
import {
  useDeletePhoneNumber,
  usePhoneNumberBulkAction,
  usePhoneNumbers,
  useSyncNumberWithVapi,
  useUpdatePhoneNumber,
  type PhoneNumberFilters,
} from '../../hooks/usePhoneNumbers';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';
import { ImportNumberModal } from '../../components/phoneNumbers/ImportNumberModal';

function CapabilityBadges({ capabilities }: { capabilities: PhoneNumber['capabilities'] }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1">
      {capabilities.voice_inbound && <Badge tone="success">Inbound</Badge>}
      {capabilities.voice_outbound && <Badge tone="success">Outbound</Badge>}
      {capabilities.sms && <Badge tone="neutral">SMS</Badge>}
      {!capabilities.voice_inbound && !capabilities.voice_outbound && !capabilities.sms && <Badge tone="neutral">None</Badge>}
    </div>
  );
}

function VapiSyncStatus({ number }: { number: PhoneNumber }): JSX.Element {
  const sync = useSyncNumberWithVapi();
  const [error, setError] = useState<string | null>(null);

  if (number.vapi_phone_number_id) {
    return <Badge tone="success">Synced</Badge>;
  }

  return (
    <div>
      <Button
        variant="secondary"
        disabled={sync.isPending}
        onClick={async () => {
          setError(null);
          try {
            await sync.mutateAsync(number.id);
          } catch (err) {
            setError(err instanceof ApiClientError ? err.message : 'Could not sync this number with Vapi.');
          }
        }}
      >
        {sync.isPending ? 'Syncing...' : 'Sync to Vapi'}
      </Button>
      {error && <p className="mt-1 max-w-[12rem] text-xs text-red-600">{error}</p>}
    </div>
  );
}

function AssignAgentSelect({ number }: { number: PhoneNumber }): JSX.Element {
  const agentsQuery = useAgents(1, 100);
  const update = useUpdatePhoneNumber();
  const agents = agentsQuery.data?.data ?? [];
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <select
        className="rounded-md border border-ink-300 bg-white px-2 py-1 text-xs"
        value={number.assigned_agent_id ?? ''}
        onChange={async (e) => {
          setError(null);
          try {
            await update.mutateAsync({ id: number.id, assigned_agent_id: e.target.value || null });
          } catch (err) {
            setError(err instanceof ApiClientError ? err.message : 'Could not update assignment.');
          }
        }}
      >
        <option value="">Unassigned</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function ActivateToggle({ number }: { number: PhoneNumber }): JSX.Element {
  const update = useUpdatePhoneNumber();
  const isActive = number.status === 'active';
  return (
    <Button
      variant="secondary"
      disabled={update.isPending || number.status === 'releasing'}
      onClick={() => update.mutate({ id: number.id, status: isActive ? 'inactive' : 'active' })}
    >
      {isActive ? 'Deactivate' : 'Activate'}
    </Button>
  );
}

function DeleteNumberButton({ number }: { number: PhoneNumber }): JSX.Element {
  const deleteNumber = useDeletePhoneNumber();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="space-y-1">
        {number.provider_key !== 'byon' && (
          <p className="max-w-[14rem] text-xs text-ink-500">
            This removes {number.phone_number} from ShivanshConnect only - it will NOT be released from your{' '}
            {TELEPHONY_PROVIDER_LABELS[number.provider_key]} account.
          </p>
        )}
        <div className="flex items-center gap-1">
          <Button variant="danger" disabled={deleteNumber.isPending} onClick={() => deleteNumber.mutate(number.id)}>
            Confirm
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <Button variant="ghost" onClick={() => setConfirming(true)} aria-label="Delete phone number">
      <Trash2 className="h-4 w-4 text-red-600" />
    </Button>
  );
}

export function NumbersTab(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('numbers.manage');
  const [filters, setFilters] = useState<PhoneNumberFilters>({});
  const [showImport, setShowImport] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const numbersQuery = usePhoneNumbers(filters);
  const providersQuery = useTelephonyProviders();
  const bulkAction = usePhoneNumberBulkAction();
  const numbers = numbersQuery.data?.data ?? [];
  const agentsQuery = useAgents(1, 100);
  const agents = agentsQuery.data?.data ?? [];
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  function toggleNumber(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === numbers.length ? new Set() : new Set(numbers.map((n) => n.id))));
  }

  function resetSelection() {
    setSelected(new Set());
    setConfirmingBulkDelete(false);
  }

  async function handleBulkDelete() {
    setBulkError(null);
    try {
      await bulkAction.mutateAsync({ phone_number_ids: Array.from(selected), action: 'delete' });
      resetSelection();
    } catch (err) {
      setBulkError(err instanceof ApiClientError ? err.message : 'Could not delete the selected numbers.');
    }
  }

  async function handleBulkAssign(agentId: string) {
    setBulkError(null);
    try {
      await bulkAction.mutateAsync({ phone_number_ids: Array.from(selected), action: 'assign_agent', assigned_agent_id: agentId || null });
      resetSelection();
    } catch (err) {
      setBulkError(err instanceof ApiClientError ? err.message : 'Could not reassign the selected numbers.');
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          Phone numbers (DIDs) registered for this organization - synced from a connected Twilio or Telnyx account, or
          declared manually via Bring Your Own Number. Assign one to an AI agent to route calls to it.
        </p>
        {canManage && (
          <Button onClick={() => setShowImport(true)}>
            <Plus className="h-3.5 w-3.5" /> Import
          </Button>
        )}
      </div>

      {providersQuery.data && providersQuery.data.every((p) => p.key === 'byon' || p.status !== 'connected') && (
        <div className="mt-4">
          <Alert variant="info">
            No Twilio or Telnyx account is connected yet - go to the "Provider Connections" tab to add credentials, or
            use Bring Your Own Number to declare a number manually.
          </Alert>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <select
          className="rounded-md border border-ink-300 bg-white px-2 py-1"
          value={filters.provider_key ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, provider_key: (e.target.value || undefined) as TelephonyProviderKey | undefined }))}
        >
          <option value="">All providers</option>
          {Object.entries(TELEPHONY_PROVIDER_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-ink-300 bg-white px-2 py-1"
          value={filters.status ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="releasing">Releasing</option>
        </select>
      </div>

      {canManage && selected.size > 0 && (
        <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 !p-3">
          <div className="flex items-center gap-3 text-sm text-ink-700">
            <span>
              <strong>{selected.size}</strong> selected
            </span>
            <button type="button" className="text-xs text-ink-500 underline" onClick={resetSelection}>
              Clear selection
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border border-ink-300 bg-white px-2 py-1.5 text-sm"
              defaultValue=""
              disabled={bulkAction.isPending}
              onChange={(e) => {
                handleBulkAssign(e.target.value);
                e.target.value = '';
              }}
            >
              <option value="" disabled>
                Assign to agent...
              </option>
              <option value="">Unassign</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {confirmingBulkDelete ? (
              <>
                <span className="text-xs text-ink-600">Delete {selected.size} number(s)?</span>
                <Button variant="danger" disabled={bulkAction.isPending} onClick={handleBulkDelete}>
                  {bulkAction.isPending ? 'Deleting...' : 'Confirm'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingBulkDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmingBulkDelete(true)}>
                <Trash2 className="h-4 w-4" /> Delete selected
              </Button>
            )}
          </div>
        </Card>
      )}
      {bulkError && (
        <div className="mt-3">
          <Alert>{bulkError}</Alert>
        </div>
      )}

      {numbersQuery.isLoading && <p className="mt-6 text-sm text-ink-500">Loading phone numbers...</p>}

      {!numbersQuery.isLoading && numbers.length === 0 && (
        <Card className="mt-6 py-12 text-center text-sm text-ink-500">
          No phone numbers registered yet. Click "Import" to sync from a connected provider or declare a BYON number.
        </Card>
      )}

      {numbers.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-ink-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase text-ink-500">
              <tr>
                {canManage && (
                  <th className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={numbers.length > 0 && selected.size === numbers.length}
                      onChange={toggleAll}
                      aria-label="Select all phone numbers"
                    />
                  </th>
                )}
                <th className="px-4 py-2">Number</th>
                <th className="px-4 py-2">Provider</th>
                <th className="px-4 py-2">Capabilities</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Vapi</th>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {numbers.map((number) => (
                <tr key={number.id}>
                  {canManage && (
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.has(number.id)} onChange={() => toggleNumber(number.id)} aria-label={`Select ${number.phone_number}`} />
                    </td>
                  )}
                  <td className="px-4 py-3 font-mono text-ink-800">
                    {number.phone_number}
                    {number.friendly_name && <div className="font-sans text-xs text-ink-500">{number.friendly_name}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={number.provider_key === 'byon' ? 'warning' : 'success'}>{TELEPHONY_PROVIDER_LABELS[number.provider_key]}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <CapabilityBadges capabilities={number.capabilities} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={number.status === 'active' ? 'success' : number.status === 'releasing' ? 'warning' : 'neutral'}>{number.status}</Badge>
                  </td>
                  <td className="px-4 py-3">{canManage ? <VapiSyncStatus number={number} /> : <Badge tone={number.vapi_phone_number_id ? 'success' : 'neutral'}>{number.vapi_phone_number_id ? 'Synced' : 'Not synced'}</Badge>}</td>
                  <td className="px-4 py-3">
                    {canManage ? (
                      <AssignAgentSelect number={number} />
                    ) : (
                      <span className="text-xs text-ink-600">{number.assigned_agent_id ? agentNameById.get(number.assigned_agent_id) ?? 'Assigned' : 'Unassigned'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-500">{new Date(number.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    {canManage && (
                      <div className="flex items-center gap-2">
                        <ActivateToggle number={number} />
                        <DeleteNumberButton number={number} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showImport && <ImportNumberModal providers={providersQuery.data ?? []} onClose={() => setShowImport(false)} />}
    </div>
  );
}
