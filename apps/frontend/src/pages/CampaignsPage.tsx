import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Megaphone, Plus } from 'lucide-react';
import { CAMPAIGN_STATUS_LABELS, type CampaignStatus } from '@shivanshconnect/shared';
import { useAuth } from '../hooks/useAuth';
import {
  useCampaignLifecycleAction,
  useCampaigns,
  useCreateCampaign,
  useDuplicateCampaign,
  type CampaignWithCounts,
} from '../hooks/useCampaigns';
import { usePhoneNumbers } from '../hooks/usePhoneNumbers';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';

const STATUS_TONE: Record<CampaignStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  scheduled: 'warning',
  running: 'success',
  paused: 'warning',
  completed: 'neutral',
  stopped: 'danger',
  failed: 'danger',
  archived: 'neutral',
};

export function CampaignsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const campaignsQuery = useCampaigns();
  const campaigns = campaignsQuery.data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Campaigns</h1>
          <p className="mt-1 text-sm text-ink-500">Configure, launch and monitor your outbound dialing campaigns.</p>
        </div>
        {hasPermission('campaigns.create') && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        )}
      </div>

      {showCreate && <CreateCampaignForm onClose={() => setShowCreate(false)} />}

      {campaignsQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading campaigns...</p>}

      {!campaignsQuery.isLoading && campaigns.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <Megaphone className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No campaigns yet</p>
          <p className="mt-1 text-sm text-ink-500">Create one to start dialing a lead list.</p>
        </Card>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {campaigns.map((c) => (
          <CampaignCard key={c.id} campaign={c} />
        ))}
      </div>
    </div>
  );
}

function CampaignCard({ campaign }: { campaign: CampaignWithCounts }): JSX.Element {
  const { hasPermission } = useAuth();
  const start = useCampaignLifecycleAction('start');
  const pause = useCampaignLifecycleAction('pause');
  const resume = useCampaignLifecycleAction('resume');
  const stop = useCampaignLifecycleAction('stop');
  const archive = useCampaignLifecycleAction('archive');
  const duplicate = useDuplicateCampaign();

  const counts = campaign.counts;
  const called = counts.total - counts.pending - counts.retry_pending;
  const progressPct = counts.total > 0 ? Math.round((called / counts.total) * 100) : 0;
  const busy = start.isPending || pause.isPending || resume.isPending || stop.isPending || archive.isPending;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/campaigns/${campaign.id}`} className="truncate text-sm font-semibold text-ink-900 hover:underline">
            {campaign.name}
          </Link>
          {campaign.description && <p className="mt-0.5 truncate text-xs text-ink-500">{campaign.description}</p>}
        </div>
        <Badge tone={STATUS_TONE[campaign.status]}>{CAMPAIGN_STATUS_LABELS[campaign.status]}</Badge>
      </div>

      <div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100">
          <div className="h-full rounded-full bg-ink-900" style={{ width: `${progressPct}%` }} />
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-ink-500">
          <span>Called: {called} / {counts.total}</span>
          <span>Remaining: {counts.pending + counts.retry_pending}</span>
          <span>Connected: {counts.connected + counts.completed}</span>
          <span>Failed: {counts.failed}</span>
          <span>DNC: {counts.dnc}</span>
          <span>Skipped: {counts.skipped}</span>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-ink-500">
        <span>Concurrency: {counts.active_calls} / {campaign.concurrency_limit}</span>
        {campaign.calls_per_minute_limit && <span>{campaign.calls_per_minute_limit}/min</span>}
      </div>

      {hasPermission('campaigns.start') && (
        <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
          {['draft', 'scheduled', 'paused'].includes(campaign.status) && (
            <Button variant="secondary" disabled={busy} onClick={() => (campaign.status === 'paused' ? resume : start).mutate(campaign.id)}>
              {campaign.status === 'paused' ? 'Resume' : 'Start'}
            </Button>
          )}
          {campaign.status === 'running' && (
            <Button variant="secondary" disabled={busy} onClick={() => pause.mutate(campaign.id)}>
              Pause
            </Button>
          )}
          {['running', 'paused', 'scheduled'].includes(campaign.status) && (
            <Button variant="secondary" disabled={busy} onClick={() => stop.mutate(campaign.id)}>
              Stop
            </Button>
          )}
          <Button variant="ghost" disabled={duplicate.isPending} onClick={() => duplicate.mutate(campaign.id)}>
            Duplicate
          </Button>
          {['draft', 'stopped', 'completed', 'failed'].includes(campaign.status) && hasPermission('campaigns.delete') && (
            <Button variant="ghost" disabled={busy} onClick={() => archive.mutate(campaign.id)}>
              Archive
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function CreateCampaignForm({ onClose }: { onClose: () => void }): JSX.Element {
  const createCampaign = useCreateCampaign();
  const phoneNumbersQuery = usePhoneNumbers({ status: 'active' });
  const [name, setName] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const campaign = await createCampaign.mutateAsync({ name, phone_number_id: phoneNumberId || undefined });
      window.location.assign(`/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create campaign.');
    }
  }

  return (
    <Card className="mt-6 max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <h2 className="text-sm font-semibold text-ink-900">New campaign</h2>
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="campaign-name">Name</Label>
          <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </div>
        <div>
          <Label htmlFor="campaign-phone">Phone number</Label>
          <select
            id="campaign-phone"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
          >
            <option value="">Select later</option>
            {(phoneNumbersQuery.data?.data ?? []).map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.friendly_name ?? p.phone_number}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createCampaign.isPending}>
            Create draft
          </Button>
        </div>
      </form>
    </Card>
  );
}
