import { useState } from 'react';
import { TELEPHONY_PROVIDER_LABELS, type TelephonyProviderKey, type TelephonyProviderSummary } from '@shivanshconnect/shared';
import { Alert, Badge, Button, Input, Label } from '../ui';
import { useImportPhoneNumber, useSyncPhoneNumbers } from '../../hooks/usePhoneNumbers';
import { ApiClientError } from '../../lib/apiClient';

interface ImportNumberModalProps {
  providers: TelephonyProviderSummary[];
  onClose: () => void;
}

const CONNECTED_PROVIDERS: TelephonyProviderKey[] = ['twilio', 'telnyx'];

export function ImportNumberModal({ providers, onClose }: ImportNumberModalProps): JSX.Element {
  const connected = providers.filter((p) => CONNECTED_PROVIDERS.includes(p.key) && p.status === 'connected');
  const [mode, setMode] = useState<'sync' | 'byon'>(connected.length > 0 ? 'sync' : 'byon');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink-900">Import a phone number</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-600" aria-label="Close">
            &times;
          </button>
        </div>

        <div className="mt-4 flex gap-2 border-b border-ink-200 pb-2 text-sm">
          <button
            onClick={() => setMode('sync')}
            className={mode === 'sync' ? 'rounded-md bg-ink-900 px-3 py-1.5 text-white' : 'rounded-md border border-ink-300 px-3 py-1.5 text-ink-700'}
          >
            Sync from a connected provider
          </button>
          <button
            onClick={() => setMode('byon')}
            className={mode === 'byon' ? 'rounded-md bg-ink-900 px-3 py-1.5 text-white' : 'rounded-md border border-ink-300 px-3 py-1.5 text-ink-700'}
          >
            Bring Your Own Number
          </button>
        </div>

        <div className="mt-4">
          {mode === 'sync' ? (
            <SyncFromProviderPanel connected={connected} onDone={onClose} />
          ) : (
            <ByonImportForm onDone={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

function SyncFromProviderPanel({ connected, onDone }: { connected: TelephonyProviderSummary[]; onDone: () => void }): JSX.Element {
  const sync = useSyncPhoneNumbers();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (connected.length === 0) {
    return (
      <Alert variant="info">
        No Twilio or Telnyx connection is set up yet. Go to the "Provider Connections" tab to add credentials and test
        the connection first, or use "Bring Your Own Number" instead.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-500">
        Pulls every number your organization currently owns on the connected account and registers any that aren't
        already here. Numbers already registered are updated, never duplicated.
      </p>
      {error && <Alert>{error}</Alert>}
      {result && <Alert variant="success">{result}</Alert>}
      <div className="flex flex-wrap gap-2">
        {connected.map((p) => (
          <Button
            key={p.key}
            variant="secondary"
            disabled={sync.isPending}
            onClick={async () => {
              setError(null);
              setResult(null);
              try {
                const res = await sync.mutateAsync(p.key);
                setResult(`Synced ${res.total_remote} number(s) from ${TELEPHONY_PROVIDER_LABELS[p.key]}: ${res.created} new, ${res.updated} updated.`);
              } catch (err) {
                setError(err instanceof ApiClientError ? err.message : 'Sync failed.');
              }
            }}
          >
            {sync.isPending ? 'Syncing...' : `Sync ${TELEPHONY_PROVIDER_LABELS[p.key]}`}
          </Button>
        ))}
      </div>
      {result && (
        <div className="pt-2">
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

function ByonImportForm({ onDone }: { onDone: () => void }): JSX.Element {
  const importNumber = useImportPhoneNumber();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [friendlyName, setFriendlyName] = useState('');
  const [voiceInbound, setVoiceInbound] = useState(true);
  const [voiceOutbound, setVoiceOutbound] = useState(true);
  const [sms, setSms] = useState(false);
  const [useSipTrunk, setUseSipTrunk] = useState(false);
  const [sipHost, setSipHost] = useState('');
  const [sipUsername, setSipUsername] = useState('');
  const [sipPassword, setSipPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await importNumber.mutateAsync({
        provider_key: 'byon',
        phone_number: phoneNumber.trim(),
        friendly_name: friendlyName.trim() || undefined,
        capabilities: { voice_inbound: voiceInbound, voice_outbound: voiceOutbound, sms },
        sip_trunk_metadata: useSipTrunk && sipHost && sipUsername && sipPassword ? { host: sipHost, username: sipUsername, password: sipPassword } : undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not import this number.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-sm text-ink-500">
        Declare a number you already control - on your own SIP trunk, or ported through your own carrier. There is no
        third-party API for BYON: this platform trusts your declaration and validates only the E.164 format.
      </p>
      {error && <Alert>{error}</Alert>}
      <div>
        <Label htmlFor="byon-e164">Phone number (E.164, e.g. +14845551234)</Label>
        <Input id="byon-e164" required value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+14845551234" />
      </div>
      <div>
        <Label htmlFor="byon-name">Friendly name (optional)</Label>
        <Input id="byon-name" value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)} placeholder="Main line" />
      </div>
      <div>
        <Label>Capabilities</Label>
        <div className="flex flex-wrap gap-4 text-sm text-ink-700">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={voiceInbound} onChange={(e) => setVoiceInbound(e.target.checked)} /> Voice inbound
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={voiceOutbound} onChange={(e) => setVoiceOutbound(e.target.checked)} /> Voice outbound
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> SMS
          </label>
        </div>
      </div>
      <div>
        <label className="flex items-center gap-1.5 text-sm text-ink-700">
          <input type="checkbox" checked={useSipTrunk} onChange={(e) => setUseSipTrunk(e.target.checked)} /> This number routes through a SIP trunk
          <Badge tone="neutral">optional</Badge>
        </label>
      </div>
      {useSipTrunk && (
        <div className="grid gap-3 rounded-md bg-ink-50 p-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="byon-sip-host">SIP host</Label>
            <Input id="byon-sip-host" value={sipHost} onChange={(e) => setSipHost(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="byon-sip-user">Username</Label>
            <Input id="byon-sip-user" value={sipUsername} onChange={(e) => setSipUsername(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="byon-sip-pass">Password</Label>
            <Input id="byon-sip-pass" type="password" value={sipPassword} onChange={(e) => setSipPassword(e.target.value)} />
          </div>
        </div>
      )}
      <div className="pt-2">
        <Button type="submit" disabled={importNumber.isPending}>
          {importNumber.isPending ? 'Importing...' : 'Import number'}
        </Button>
      </div>
    </form>
  );
}
