import { Badge, Card } from '../../components/ui';
import { useSystemHealth, type SystemHealthComponent } from '../../hooks/useOrchestration';

function statusTone(status: SystemHealthComponent['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'connected') return 'success';
  if (status === 'warning') return 'warning';
  if (status === 'error') return 'danger';
  return 'neutral';
}

function componentLabel(component: string): string {
  const overrides: Record<string, string> = {
    database: 'Database',
    call_reconciliation_scheduler: 'Call reconciliation scheduler',
    storage: 'Storage',
    pipecat_service: 'Pipecat service',
    vapi: 'Vapi',
    twilio: 'Twilio',
    telnyx: 'Telnyx',
    smtp: 'SMTP (email)',
    voice_elevenlabs: 'ElevenLabs',
    voice_cartesia: 'Cartesia',
    voice_omnivoice: 'OmniVoice',
    voice_voxcpm: 'VoxCPM',
  };
  return overrides[component] ?? component;
}

export function SystemHealthSettingsPage(): JSX.Element {
  const healthQuery = useSystemHealth();
  const health = healthQuery.data;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink-900">System health</h2>
          <p className="mt-1 text-sm text-ink-500">
            Real checks against the database, this org&apos;s connected providers, the in-process schedulers and
            storage - never a hard-coded &ldquo;everything&apos;s fine&rdquo;. A provider shows the last time it was
            actually verified, not a live re-check on every page load.
          </p>
        </div>
        {health && (
          <Badge tone={statusTone(health.overall)}>
            {health.overall === 'connected' ? 'All systems normal' : health.overall}
          </Badge>
        )}
      </div>

      <div className="mt-4">
        <button
          type="button"
          className="rounded-md border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          onClick={() => healthQuery.refetch()}
          disabled={healthQuery.isFetching}
        >
          {healthQuery.isFetching ? 'Checking...' : 'Re-check now'}
        </button>
        {health && (
          <span className="ml-3 text-xs text-ink-400">Last checked {new Date(health.checked_at).toLocaleString()}</span>
        )}
      </div>

      {healthQuery.isLoading && <p className="mt-6 text-sm text-ink-500">Checking system health...</p>}
      {healthQuery.isError && <p className="mt-6 text-sm text-red-600">Could not load system health.</p>}

      {health && (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {health.components.map((c) => (
            <Card key={c.component} className="p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink-900">{componentLabel(c.component)}</h3>
                <Badge tone={statusTone(c.status)}>{c.status.replace('_', ' ')}</Badge>
              </div>
              <p className="mt-2 text-xs text-ink-500">{c.detail}</p>
              <p className="mt-2 text-xs text-ink-400">Checked {new Date(c.lastCheckedAt).toLocaleString()}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
