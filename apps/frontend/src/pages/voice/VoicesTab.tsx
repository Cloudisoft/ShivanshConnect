import { useRef, useState } from 'react';
import { Play, RefreshCw, Trash2 } from 'lucide-react';
import { VOICE_PROVIDER_LABELS, type Voice, type VoiceProviderKey } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import { useBulkDeleteVoices, useDeleteVoice, usePreviewVoice, useSyncVoices, useVoices, type VoiceFilters } from '../../hooks/useVoices';
import { useVoiceProviders } from '../../hooks/useVoiceProviders';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(/\/api\/v1\/?$/, '');

function ProviderBadge({ provider }: { provider: VoiceProviderKey }): JSX.Element {
  const hosted = provider === 'omnivoice' || provider === 'voxcpm';
  return <Badge tone={hosted ? 'warning' : 'success'}>{hosted ? 'Self-hosted' : 'Managed'}</Badge>;
}

function PlayPreviewButton({ voice }: { voice: Voice }): JSX.Element {
  const preview = usePreviewVoice();
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function handlePlay() {
    setError(null);
    try {
      const result = await preview.mutateAsync({ id: voice.id });
      const url = result.url.startsWith('http') ? result.url : `${API_ORIGIN}${result.url}`;
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : 'Could not generate a preview.');
    }
  }

  return (
    <div>
      <Button variant="secondary" onClick={handlePlay} disabled={preview.isPending}>
        <Play className="h-3.5 w-3.5" /> {preview.isPending ? 'Generating...' : 'Play'}
      </Button>
      <audio ref={audioRef} className="hidden" />
      {error && <p className="mt-1 max-w-xs text-xs text-red-600">{error}</p>}
    </div>
  );
}

function DeleteVoiceButton({ voice }: { voice: Voice }): JSX.Element {
  const deleteVoice = useDeleteVoice();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button variant="danger" disabled={deleteVoice.isPending} onClick={() => deleteVoice.mutate(voice.id)}>
          Confirm
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <Button variant="ghost" onClick={() => setConfirming(true)} aria-label="Delete voice">
      <Trash2 className="h-4 w-4 text-red-600" />
    </Button>
  );
}

function SyncButton({ providerKey }: { providerKey: VoiceProviderKey }): JSX.Element {
  const sync = useSyncVoices();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        disabled={sync.isPending}
        onClick={async () => {
          setMessage(null);
          try {
            const result = await sync.mutateAsync(providerKey);
            setMessage(`Synced: ${result.created} new, ${result.updated} updated.`);
          } catch (err) {
            setMessage(err instanceof ApiClientError ? err.message : 'Sync failed.');
          }
        }}
      >
        <RefreshCw className="h-3.5 w-3.5" /> Sync {VOICE_PROVIDER_LABELS[providerKey]}
      </Button>
      {message && <span className="text-xs text-ink-500">{message}</span>}
    </div>
  );
}

export function VoicesTab(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('voices.manage');
  const [filters, setFilters] = useState<VoiceFilters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const voicesQuery = useVoices(filters);
  const providersQuery = useVoiceProviders();
  const bulkDelete = useBulkDeleteVoices();
  const voices = voicesQuery.data?.data ?? [];
  const connectedProviders = (providersQuery.data ?? []).filter((p) => p.status === 'connected');

  function toggleVoice(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === voices.length ? new Set() : new Set(voices.map((v) => v.id))));
  }

  async function handleBulkDelete() {
    setBulkError(null);
    try {
      await bulkDelete.mutateAsync(Array.from(selected));
      setSelected(new Set());
      setConfirmingBulkDelete(false);
    } catch (err) {
      setBulkError(err instanceof ApiClientError ? err.message : 'Could not delete the selected voices.');
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          Voices registered for this organization - synced from a connected provider, or created by cloning. Attach one
          to an AI agent under its Configuration tab.
        </p>
        {canManage && connectedProviders.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {connectedProviders.map((p) => (
              <SyncButton key={p.key} providerKey={p.key} />
            ))}
          </div>
        )}
      </div>

      {canManage && connectedProviders.length === 0 && !providersQuery.isLoading && (
        <Alert variant="info">
          No voice provider is connected yet. Go to the "Provider Connections" tab to add credentials, then sync.
        </Alert>
      )}

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <select
          className="rounded-md border border-ink-300 bg-white px-2 py-1"
          value={filters.provider_key ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, provider_key: (e.target.value || undefined) as VoiceProviderKey | undefined }))}
        >
          <option value="">All providers</option>
          {Object.entries(VOICE_PROVIDER_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-ink-300 bg-white px-2 py-1"
          value={filters.gender ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, gender: e.target.value || undefined }))}
        >
          <option value="">Any gender</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="neutral">Neutral</option>
          <option value="unknown">Unknown</option>
        </select>
      </div>

      {canManage && selected.size > 0 && (
        <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 !p-3">
          <div className="flex items-center gap-3 text-sm text-ink-700">
            <span>
              <strong>{selected.size}</strong> selected
            </span>
            <button type="button" className="text-xs text-ink-500 underline" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
          {confirmingBulkDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-600">Delete {selected.size} voice(s)?</span>
              <Button variant="danger" disabled={bulkDelete.isPending} onClick={handleBulkDelete}>
                {bulkDelete.isPending ? 'Deleting...' : 'Confirm'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingBulkDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmingBulkDelete(true)}>
              <Trash2 className="h-4 w-4" /> Delete selected
            </Button>
          )}
        </Card>
      )}
      {bulkError && (
        <div className="mt-3">
          <Alert>{bulkError}</Alert>
        </div>
      )}

      {voicesQuery.isLoading && <p className="mt-6 text-sm text-ink-500">Loading voices...</p>}

      {!voicesQuery.isLoading && voices.length === 0 && (
        <Card className="mt-6 py-12 text-center text-sm text-ink-500">
          No voices registered yet. Sync a connected provider's catalog, or clone a voice, to get started.
        </Card>
      )}

      {voices.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-ink-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase text-ink-500">
              <tr>
                {canManage && (
                  <th className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={voices.length > 0 && selected.size === voices.length}
                      onChange={toggleAll}
                      aria-label="Select all voices"
                    />
                  </th>
                )}
                <th className="px-4 py-2">Provider</th>
                <th className="px-4 py-2">Voice name</th>
                <th className="px-4 py-2">Gender</th>
                <th className="px-4 py-2">Language</th>
                <th className="px-4 py-2">Accent</th>
                <th className="px-4 py-2">Voice ID</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {voices.map((voice) => (
                <tr key={voice.id}>
                  {canManage && (
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.has(voice.id)} onChange={() => toggleVoice(voice.id)} aria-label={`Select ${voice.name}`} />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-800">{VOICE_PROVIDER_LABELS[voice.provider_key]}</span>
                      <ProviderBadge provider={voice.provider_key} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {voice.name}
                    {voice.is_cloned && <Badge tone="neutral">cloned</Badge>}
                  </td>
                  <td className="px-4 py-3 capitalize text-ink-600">{voice.gender ?? 'unknown'}</td>
                  <td className="px-4 py-3 text-ink-600">{voice.language ?? '-'}</td>
                  <td className="px-4 py-3 text-ink-600">{voice.accent ?? '-'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-500">{voice.provider_voice_id.slice(0, 24)}</td>
                  <td className="px-4 py-3">
                    {voice.is_cloned && voice.clone_status && voice.clone_status !== 'ready' && voice.clone_status !== 'n/a' ? (
                      <span title={voice.clone_status === 'failed' && voice.clone_error ? voice.clone_error : undefined}>
                        <Badge tone={voice.clone_status === 'failed' ? 'danger' : 'warning'}>{voice.clone_status}</Badge>
                      </span>
                    ) : (
                      <Badge tone={voice.status === 'active' ? 'success' : 'neutral'}>{voice.status}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <PlayPreviewButton voice={voice} />
                      {canManage && <DeleteVoiceButton voice={voice} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
