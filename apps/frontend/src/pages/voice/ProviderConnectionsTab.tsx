import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { VoiceProviderSummary } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import { useSaveVoiceProviderCredentials, useTestVoiceProviderConnection, useVoiceProviders } from '../../hooks/useVoiceProviders';
import { Alert, Badge, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

const SELF_HOSTED_DOCS: Record<string, string> = {
  omnivoice:
    'Deploy the OmniVoice (k2-fsa) model as a Replicate custom model deployment, then paste that deployment\'s predictions URL and your Replicate API token below. See apps/backend/src/lib/voice/omnivoice.ts for the exact steps.',
  voxcpm:
    'Serve VoxCPM (OpenBMB) via its official vLLM-Omni integration ("vllm serve openbmb/VoxCPM2 --omni"), which exposes an OpenAI-compatible endpoint, then paste its base URL and bearer token below. See apps/backend/src/lib/voice/voxcpm.ts for the exact steps.',
};

function ProviderCard({ provider }: { provider: VoiceProviderSummary }): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('voices.manage');
  const save = useSaveVoiceProviderCredentials();
  const test = useTestVoiceProviderConnection();

  const [apiKey, setApiKey] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      if (provider.requires_external_hosting) {
        if (!endpointUrl.trim() || !apiKey.trim()) throw new Error('Both an endpoint URL and an API key are required.');
        await save.mutateAsync({ key: provider.key, kind: 'endpoint', endpoint_url: endpointUrl.trim(), api_key: apiKey.trim() });
      } else {
        if (!apiKey.trim()) throw new Error('An API key is required.');
        await save.mutateAsync({ key: provider.key, kind: 'api_key', api_key: apiKey.trim() });
      }
      setApiKey('');
      setEndpointUrl('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : 'Could not save credentials.');
    }
  }

  async function handleTest() {
    setTestResult(null);
    try {
      const result = await test.mutateAsync(provider.key);
      setTestResult({ success: result.success, message: result.success ? 'Connection verified.' : result.last_error ?? 'Connection failed.' });
    } catch (err) {
      setTestResult({ success: false, message: err instanceof ApiClientError ? err.message : 'Connection test failed.' });
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink-900">{provider.display_name}</h3>
            <Badge tone={provider.requires_external_hosting ? 'warning' : 'success'}>
              {provider.requires_external_hosting ? 'Self-hosted - endpoint required' : 'Managed'}
            </Badge>
            <Badge tone={provider.status === 'connected' ? 'success' : provider.status === 'error' ? 'danger' : 'neutral'}>
              {provider.status.replace('_', ' ')}
            </Badge>
          </div>
          {provider.masked_credential && <p className="mt-1 text-xs text-ink-500">Current: {provider.masked_credential}</p>}
          {provider.last_error && <p className="mt-1 text-xs text-red-600">{provider.last_error}</p>}
        </div>
      </div>

      {provider.requires_external_hosting && (
        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-ink-50 p-3 text-xs text-ink-600">
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {SELF_HOSTED_DOCS[provider.key]}
        </p>
      )}

      {canManage && (
        <div className="mt-4 space-y-2">
          {error && <Alert>{error}</Alert>}
          {saved && !error && <Alert variant="success">Credentials saved.</Alert>}
          {provider.requires_external_hosting && (
            <div>
              <Label htmlFor={`${provider.key}-endpoint`}>Endpoint URL</Label>
              <Input
                id={`${provider.key}-endpoint`}
                placeholder="https://..."
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
              />
            </div>
          )}
          <div>
            <Label htmlFor={`${provider.key}-key`}>{provider.requires_external_hosting ? 'API key / bearer token' : 'API key'}</Label>
            <Input
              id={`${provider.key}-key`}
              type="password"
              placeholder={provider.masked_credential ? 'Enter a new value to replace it' : 'sk-...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="secondary" disabled={save.isPending} onClick={handleSave}>
              {save.isPending ? 'Saving...' : 'Save credentials'}
            </Button>
            <Button
              variant="secondary"
              disabled={test.isPending || provider.status === 'not_connected'}
              onClick={handleTest}
            >
              {test.isPending ? 'Testing...' : 'Test connection'}
            </Button>
            {testResult && (
              <span className={testResult.success ? 'text-xs text-green-700' : 'text-xs text-red-600'}>{testResult.message}</span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function ProviderConnectionsTab(): JSX.Element {
  const providersQuery = useVoiceProviders();
  const providers = providersQuery.data ?? [];

  return (
    <div>
      <p className="text-sm text-ink-500">
        Connect each provider your organization wants to use. ElevenLabs and Cartesia are managed APIs - just add an
        API key. OmniVoice and VoxCPM are open-source models that require you to deploy your own serverless GPU
        endpoint first (see each card below) - they never work without one.
      </p>
      {providersQuery.isLoading && <p className="mt-6 text-sm text-ink-500">Loading providers...</p>}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {providers.map((p: VoiceProviderSummary) => (
          <ProviderCard key={p.key} provider={p} />
        ))}
      </div>
    </div>
  );
}

