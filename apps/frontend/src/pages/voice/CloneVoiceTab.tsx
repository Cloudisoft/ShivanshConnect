import { useState, type FormEvent } from 'react';
import { VOICE_PROVIDER_LABELS, type Voice, type VoiceProviderKey } from '@shivanshconnect/shared';
import { useVoiceProviders } from '../../hooks/useVoiceProviders';
import { useCloneVoice, useVoicesWithClonePolling } from '../../hooks/useVoices';
import { Alert, Badge, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

const CLONE_STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'neutral',
  processing: 'warning',
  ready: 'success',
  failed: 'danger',
};

export function CloneVoiceTab(): JSX.Element {
  const providersQuery = useVoiceProviders();
  const cloneVoice = useCloneVoice();
  const voicesQuery = useVoicesWithClonePolling();

  const cloningProviders = (providersQuery.data ?? []).filter((p) => p.status === 'connected');
  const clonedVoices = (voicesQuery.data?.data ?? []).filter((v) => v.is_cloned);

  const [providerKey, setProviderKey] = useState<VoiceProviderKey | ''>('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [gender, setGender] = useState('');
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!providerKey) {
      setError('Choose a connected provider to clone into.');
      return;
    }
    if (!file) {
      setError('Choose a reference audio sample (mp3, wav or m4a).');
      return;
    }
    if (!consent) {
      setError('You must confirm you have consent to clone this voice before submitting.');
      return;
    }
    try {
      await cloneVoice.mutateAsync({
        provider_key: providerKey,
        name,
        description: description || undefined,
        gender: gender || undefined,
        consent_confirmed: consent,
        sample: file,
      });
      setSuccess('Cloning started - see status below. It typically takes a few moments.');
      setName('');
      setDescription('');
      setGender('');
      setFile(null);
      setConsent(false);
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : 'Voice cloning failed.');
    }
  }

  return (
    <div>
      <p className="text-sm text-ink-500">
        Clone a voice from a short reference audio sample. Cloning requires explicit consent that you have the right
        to clone the voice in this sample - this cannot be skipped.
      </p>

      <Card className="mt-6 max-w-xl">
        <h3 className="text-sm font-semibold text-ink-900">New voice clone</h3>
        {cloningProviders.length === 0 && !providersQuery.isLoading && (
          <Alert variant="info">
            No connected provider supports cloning yet. Connect ElevenLabs, Cartesia, OmniVoice or VoxCPM under
            Provider Connections first.
          </Alert>
        )}
        <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
          {error && <Alert>{error}</Alert>}
          {success && <Alert variant="success">{success}</Alert>}
          <div>
            <Label htmlFor="clone_provider">Provider</Label>
            <select
              id="clone_provider"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={providerKey}
              onChange={(e) => setProviderKey(e.target.value as VoiceProviderKey)}
            >
              <option value="">Select a connected provider...</option>
              {cloningProviders.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.display_name}
                  {p.requires_external_hosting ? ' (self-hosted)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="clone_name">Voice name</Label>
            <Input id="clone_name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
          </div>
          <div>
            <Label htmlFor="clone_description">Description (optional)</Label>
            <Input id="clone_description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="clone_gender">Gender (optional)</Label>
            <select
              id="clone_gender"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
            >
              <option value="">Unspecified</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="neutral">Neutral</option>
            </select>
          </div>
          <div>
            <Label htmlFor="clone_sample">Reference audio sample (.mp3, .wav, .m4a)</Label>
            <input
              id="clone_sample"
              type="file"
              accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-m4a"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-ink-700"
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              required
            />
            I confirm I have the right and explicit consent to clone the voice in this audio sample, and that it will
            be used in accordance with the provider's terms.
          </label>
          <Button type="submit" disabled={cloneVoice.isPending || !consent}>
            {cloneVoice.isPending ? 'Starting clone...' : 'Start voice clone'}
          </Button>
        </form>
      </Card>

      <h3 className="mt-8 text-sm font-semibold text-ink-900">Cloned voices</h3>
      {clonedVoices.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No cloned voices yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {clonedVoices.map((v: Voice) => (
            <Card key={v.id} className="flex items-center justify-between py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-800">{v.name}</p>
                <p className="text-xs text-ink-500">{VOICE_PROVIDER_LABELS[v.provider_key]}</p>
                {v.clone_status === 'failed' && v.clone_error && (
                  <p className="mt-1 text-xs text-red-600">{v.clone_error}</p>
                )}
              </div>
              <Badge tone={CLONE_STATUS_TONE[v.clone_status ?? 'pending']}>{v.clone_status}</Badge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
