import { useState } from 'react';
import type { TelephonyProviderSummary } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import {
  useSaveTelephonyProviderCredentials,
  useTelephonyProviders,
  useTestTelephonyProviderConnection,
} from '../../hooks/useTelephonyProviders';
import { Alert, Badge, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

function TwilioTelnyxCard({ provider }: { provider: TelephonyProviderSummary }): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('numbers.manage');
  const save = useSaveTelephonyProviderCredentials();
  const test = useTestTelephonyProviderConnection();

  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      if (provider.key === 'twilio') {
        if (!accountSid.trim() || !authToken.trim()) throw new Error('Both an Account SID and Auth Token are required.');
        await save.mutateAsync({ key: 'twilio', account_sid: accountSid.trim(), auth_token: authToken.trim() });
      } else {
        if (!apiKey.trim()) throw new Error('An API key is required.');
        await save.mutateAsync({ key: 'telnyx', api_key: apiKey.trim() });
      }
      setAccountSid('');
      setAuthToken('');
      setApiKey('');
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
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink-900">{provider.display_name}</h3>
        <Badge tone={provider.status === 'connected' ? 'success' : provider.status === 'error' ? 'danger' : 'neutral'}>
          {provider.status.replace('_', ' ')}
        </Badge>
      </div>
      {provider.masked_credential && <p className="mt-1 text-xs text-ink-500">Current: {provider.masked_credential}</p>}
      {provider.last_error && <p className="mt-1 text-xs text-red-600">{provider.last_error}</p>}
      {provider.last_synced_at && <p className="mt-1 text-xs text-ink-500">Last synced: {new Date(provider.last_synced_at).toLocaleString()}</p>}

      {canManage && (
        <div className="mt-4 space-y-2">
          {error && <Alert>{error}</Alert>}
          {saved && !error && <Alert variant="success">Credentials saved.</Alert>}
          {provider.key === 'twilio' ? (
            <>
              <div>
                <Label htmlFor="twilio-sid">Account SID</Label>
                <Input id="twilio-sid" placeholder="AC..." value={accountSid} onChange={(e) => setAccountSid(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="twilio-token">Auth Token</Label>
                <Input
                  id="twilio-token"
                  type="password"
                  placeholder={provider.masked_credential ? 'Enter a new value to replace it' : 'Auth token'}
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div>
              <Label htmlFor="telnyx-key">API key</Label>
              <Input
                id="telnyx-key"
                type="password"
                placeholder={provider.masked_credential ? 'Enter a new value to replace it' : 'KEY...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="secondary" disabled={save.isPending} onClick={handleSave}>
              {save.isPending ? 'Saving...' : 'Save credentials'}
            </Button>
            <Button variant="secondary" disabled={test.isPending || provider.status === 'not_connected'} onClick={handleTest}>
              {test.isPending ? 'Testing...' : 'Test connection'}
            </Button>
            {testResult && <span className={testResult.success ? 'text-xs text-green-700' : 'text-xs text-red-600'}>{testResult.message}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

function ByonCard({ provider }: { provider: TelephonyProviderSummary }): JSX.Element {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink-900">{provider.display_name}</h3>
        <Badge tone="neutral">Manual only</Badge>
      </div>
      <p className="mt-3 text-xs text-ink-600">
        BYON is not a third-party API - there is nothing to connect here. Go to the Phone Numbers tab and click
        "Import" &rarr; "Bring Your Own Number" to declare a number you already control (e.g. on your own SIP trunk).
      </p>
    </Card>
  );
}

export function ProviderConnectionsTab(): JSX.Element {
  const providersQuery = useTelephonyProviders();
  const providers = providersQuery.data ?? [];

  return (
    <div>
      <p className="text-sm text-ink-500">
        Connect Twilio and/or Telnyx with your own account credentials to sync real numbers you already own on those
        accounts. Bring Your Own Number needs no connection - it is a manual declaration, not an API integration.
      </p>
      {providersQuery.isLoading && <p className="mt-6 text-sm text-ink-500">Loading providers...</p>}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {providers.map((p) => (p.key === 'byon' ? <ByonCard key={p.key} provider={p} /> : <TwilioTelnyxCard key={p.key} provider={p} />))}
      </div>
    </div>
  );
}
