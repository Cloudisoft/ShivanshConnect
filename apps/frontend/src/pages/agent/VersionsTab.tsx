import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AiAgentVersion } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import { useAgentVersions, useDeleteAgentVersion, usePublishAgentVersion, useRestoreAgentVersion } from '../../hooks/useAgents';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { ApiClientError, describeApiError } from '../../lib/apiClient';

const STATUS_TONE: Record<AiAgentVersion['status'], 'neutral' | 'success' | 'warning'> = {
  draft: 'neutral',
  published: 'success',
  archived: 'warning',
};

const COMPARE_FIELDS: { key: keyof AiAgentVersion; label: string }[] = [
  { key: 'system_prompt', label: 'System prompt' },
  { key: 'greeting_template', label: 'Greeting' },
  { key: 'llm_model', label: 'LLM model' },
  { key: 'llm_temperature', label: 'Temperature' },
  { key: 'language', label: 'Language' },
];

export function VersionsTab({ agentId }: { agentId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const versionsQuery = useAgentVersions(agentId);
  const publishVersion = usePublishAgentVersion(agentId);
  const restoreVersion = useRestoreAgentVersion(agentId);
  const deleteVersion = useDeleteAgentVersion(agentId);
  const [error, setError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const versions = versionsQuery.data ?? [];

  if (versionsQuery.isLoading) return <p className="text-sm text-ink-500">Loading versions...</p>;
  if (versions.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm font-medium text-ink-700">No versions yet</p>
        <p className="mt-1 text-sm text-ink-500">Save a draft on the Configuration tab to create version 1.</p>
      </Card>
    );
  }

  function toggleCompare(id: string) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }

  async function handlePublish(versionId: string) {
    setError(null);
    try {
      await publishVersion.mutateAsync(versionId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not publish this version.');
    }
  }

  async function handleRestore(versionId: string) {
    setError(null);
    try {
      await restoreVersion.mutateAsync(versionId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not restore this version.');
    }
  }

  async function handleDelete(versionId: string) {
    setError(null);
    try {
      await deleteVersion.mutateAsync(versionId);
      setConfirmingDeleteId(null);
      setCompareIds((prev) => prev.filter((id) => id !== versionId));
    } catch (err) {
      setError(err instanceof ApiClientError ? describeApiError(err, 'Could not delete this version.') : 'Could not delete this version.');
      setConfirmingDeleteId(null);
    }
  }

  const compareA = versions.find((v) => v.id === compareIds[0]);
  const compareB = versions.find((v) => v.id === compareIds[1]);

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      <p className="text-xs text-ink-500">Select up to two versions to compare their configuration side by side.</p>

      <div className="space-y-3">
        {versions.map((v) => (
          <Card key={v.id} className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={compareIds.includes(v.id)}
                onChange={() => toggleCompare(v.id)}
                aria-label={`Select version ${v.version_number} to compare`}
              />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink-900">Version {v.version_number}</span>
                  <Badge tone={STATUS_TONE[v.status]}>{v.status}</Badge>
                </div>
                <p className="text-xs text-ink-500">
                  {v.status === 'published' && v.published_at
                    ? `Published ${new Date(v.published_at).toLocaleString()}`
                    : `Created ${new Date(v.created_at).toLocaleString()}`}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {canManage && v.status !== 'published' && (
                <Button variant="secondary" disabled={publishVersion.isPending} onClick={() => handlePublish(v.id)}>
                  Publish
                </Button>
              )}
              {canManage && (
                <Button variant="ghost" disabled={restoreVersion.isPending} onClick={() => handleRestore(v.id)}>
                  Restore as new draft
                </Button>
              )}
              {canManage && v.status !== 'published' && (
                confirmingDeleteId === v.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-600">Delete v{v.version_number}?</span>
                    <Button variant="danger" disabled={deleteVersion.isPending} onClick={() => handleDelete(v.id)}>
                      {deleteVersion.isPending ? 'Deleting...' : 'Confirm'}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmingDeleteId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirmingDeleteId(v.id)} aria-label={`Delete version ${v.version_number}`}>
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                )
              )}
            </div>
          </Card>
        ))}
      </div>

      {compareA && compareB && (
        <Card>
          <h3 className="text-sm font-semibold text-ink-900">
            Comparing version {compareA.version_number} vs version {compareB.version_number}
          </h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-200 text-ink-500">
                  <th className="py-2 pr-4 font-medium">Field</th>
                  <th className="py-2 pr-4 font-medium">Version {compareA.version_number}</th>
                  <th className="py-2 font-medium">Version {compareB.version_number}</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_FIELDS.map(({ key, label }) => {
                  const a = String(compareA[key] ?? '');
                  const b = String(compareB[key] ?? '');
                  const changed = a !== b;
                  return (
                    <tr key={key} className="border-b border-ink-100 align-top">
                      <td className="py-2 pr-4 font-medium text-ink-700">{label}</td>
                      <td className={`max-w-xs whitespace-pre-wrap break-words py-2 pr-4 ${changed ? 'bg-gold-50' : ''}`}>{a || '—'}</td>
                      <td className={`max-w-xs whitespace-pre-wrap break-words py-2 ${changed ? 'bg-gold-50' : ''}`}>{b || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
