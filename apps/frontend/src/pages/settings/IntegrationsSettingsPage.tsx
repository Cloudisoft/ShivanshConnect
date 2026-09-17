import { useState } from 'react';
import { Lock } from 'lucide-react';
import { CALL_ENGINE_LABELS, CALL_ENGINES, DEFAULT_CALL_ENGINE_SETTINGS_KEY, type CallEngine } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import { useSaveVapiCredentials, useTestVapiConnection, useVapiCredentials } from '../../hooks/useOrchestration';
import { useOrganization, useUpdateOrganization } from '../../hooks/useOrganization';
import { Alert, Badge, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

const STILL_LOCKED_SECTIONS = [
  { name: 'SMTP (outbound email)', note: 'Arrives with the Notifications build phase.' },
  { name: 'Redis / job queues', note: 'Arrives with the Campaigns & Dialing build phase.' },
];

function VapiCard(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const credsQuery = useVapiCredentials();
  const save = useSaveVapiCredentials();
  const test = useTestVapiConnection();

  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const creds = credsQuery.data;

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      if (!apiKey.trim()) throw new Error('A Vapi API key is required.');
      await save.mutateAsync(apiKey.trim());
      setApiKey('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : 'Could not save credentials.');
    }
  }

  async function handleTest() {
    setTestResult(null);
    try {
      const result = await test.mutateAsync();
      setTestResult({ success: result.success, message: result.success ? 'Connection verified.' : result.last_error ?? 'Connection failed.' });
    } catch (err) {
      setTestResult({ success: false, message: err instanceof ApiClientError ? err.message : 'Connection test failed.' });
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Vapi (managed call orchestration)</h3>
        {creds && <Badge tone={creds.status === 'connected' ? 'success' : creds.status === 'error' ? 'danger' : 'neutral'}>{creds.status.replace('_', ' ')}</Badge>}
      </div>
      <p className="mt-1 text-xs text-ink-500">
        Connect your Vapi account to place calls through Vapi's managed engine. This is one of two orchestration
        engines - the other is the self-hosted Pipecat engine, selected below.
      </p>
      {creds?.masked_credential && <p className="mt-1 text-xs text-ink-500">Current key: {creds.masked_credential}</p>}
      {creds?.last_error && <p className="mt-1 text-xs text-red-600">{creds.last_error}</p>}

      {canManage && (
        <div className="mt-4 space-y-2">
          {error && <Alert>{error}</Alert>}
          {saved && !error && <Alert variant="success">Vapi credentials saved.</Alert>}
          <div>
            <Label htmlFor="vapi-api-key">API key</Label>
            <Input
              id="vapi-api-key"
              type="password"
              placeholder={creds?.masked_credential ? 'Enter a new value to replace it' : 'sk-...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="secondary" disabled={save.isPending} onClick={handleSave}>
              {save.isPending ? 'Saving...' : 'Save credentials'}
            </Button>
            <Button variant="secondary" disabled={test.isPending || !creds || creds.status === 'not_connected'} onClick={handleTest}>
              {test.isPending ? 'Testing...' : 'Test connection'}
            </Button>
            {testResult && <span className={testResult.success ? 'text-xs text-green-700' : 'text-xs text-red-600'}>{testResult.message}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

function CallEngineCard(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const orgQuery = useOrganization();
  const updateOrg = useUpdateOrganization();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const currentEngine = (orgQuery.data?.settings?.[DEFAULT_CALL_ENGINE_SETTINGS_KEY] as CallEngine | undefined) ?? 'vapi';

  async function handleChange(engine: CallEngine) {
    setError(null);
    setSaved(false);
    try {
      await updateOrg.mutateAsync({ settings: { [DEFAULT_CALL_ENGINE_SETTINGS_KEY]: engine } });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not update the default call engine.');
    }
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-ink-900">Default call engine</h3>
      <p className="mt-1 text-xs text-ink-500">
        Which engine originates a call when one isn't specified per-call - Vapi (managed) or the self-hosted Pipecat
        engine. A campaign or an individual call can still request the other engine explicitly once Phase 7 adds
        campaigns.
      </p>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {saved && !error && (
        <div className="mt-3">
          <Alert variant="success">Default call engine updated.</Alert>
        </div>
      )}
      <div className="mt-4 flex gap-3">
        {CALL_ENGINES.map((engine) => (
          <label
            key={engine}
            className={`flex-1 cursor-pointer rounded-lg border px-4 py-3 text-sm ${
              currentEngine === engine ? 'border-gold-500 bg-gold-50 text-ink-900' : 'border-ink-200 text-ink-600'
            } ${!canManage ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <input
              type="radio"
              name="default-call-engine"
              className="mr-2"
              checked={currentEngine === engine}
              disabled={!canManage || updateOrg.isPending}
              onChange={() => handleChange(engine)}
            />
            {CALL_ENGINE_LABELS[engine]}
          </label>
        ))}
      </div>
    </Card>
  );
}

export function IntegrationsSettingsPage(): JSX.Element {
  return (
    <div>
      <h2 className="text-base font-semibold text-ink-900">Integrations</h2>
      <p className="mt-1 text-sm text-ink-500">
        Twilio/Telnyx telephony connections live under the Phone Numbers module (Provider Connections tab). Call
        orchestration (Vapi + the self-hosted Pipecat engine) is configured here.
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <VapiCard />
        <CallEngineCard />
      </div>
      <div className="mt-6 divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
        {STILL_LOCKED_SECTIONS.map((section) => (
          <div key={section.name} className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium text-ink-800">{section.name}</p>
              <p className="text-xs text-ink-500">{section.note}</p>
            </div>
            <Lock className="h-4 w-4 flex-shrink-0 text-ink-300" />
          </div>
        ))}
      </div>
      <Card className="mt-6">
        <p className="text-xs text-ink-500">
          See the root README for the full phase plan and what each future build phase covers. Pipecat is a
          separate self-hosted service (apps/pipecat-service) run/deployed on its own - see its README.
        </p>
      </Card>
    </div>
  );
}
