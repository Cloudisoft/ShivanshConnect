import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowLeftRight, Info } from 'lucide-react';
import {
  BACKGROUND_NOISE_OPTIONS,
  CAMPAIGN_STATUS_LABELS,
  LEAD_COOLDOWN_PRESETS,
  type CampaignStatus,
} from '@shivanshconnect/shared';
import { useAuth } from '../hooks/useAuth';
import {
  useAttachLeads,
  useCampaign,
  useCampaignLeads,
  useCampaignLifecycleAction,
  useCampaignPreflight,
  useCreateCampaignVersion,
  usePublishCampaignVersion,
  useRotateLeads,
  useUpdateCampaign,
  useUpdateConcurrency,
  type CampaignDetail,
  type RotateDecision,
} from '../hooks/useCampaigns';
import { useAgents } from '../hooks/useAgents';
import { useVoices } from '../hooks/useVoices';
import { useKnowledgeBases } from '../hooks/useKnowledgeBases';
import { useScripts } from '../hooks/useScripts';
import { useLeadLists } from '../hooks/useLeadLists';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { PreLaunchModal } from '../components/campaigns/PreLaunchModal';
import { api, ApiClientError } from '../lib/apiClient';

const TABS = ['Overview', 'Configuration', 'Leads', 'Settings'] as const;
type Tab = (typeof TABS)[number];

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

export function CampaignDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('Overview');
  const campaignQuery = useCampaign(id);
  const campaign = campaignQuery.data;

  if (campaignQuery.isLoading || !campaign) {
    return <p className="text-sm text-ink-500">Loading campaign...</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">{campaign.name}</h1>
          {campaign.description && <p className="mt-1 text-sm text-ink-500">{campaign.description}</p>}
        </div>
        <Badge tone={STATUS_TONE[campaign.status]}>{CAMPAIGN_STATUS_LABELS[campaign.status]}</Badge>
      </div>

      <div className="mt-6 border-b border-ink-200">
        <nav className="-mb-px flex gap-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'whitespace-nowrap border-b-2 border-gold-500 pb-3 text-sm font-medium text-ink-900'
                  : 'whitespace-nowrap border-b-2 border-transparent pb-3 text-sm font-medium text-ink-500 hover:text-ink-700'
              }
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-6">
        {tab === 'Overview' && <OverviewTab campaign={campaign} />}
        {tab === 'Configuration' && <ConfigurationTab campaign={campaign} />}
        {tab === 'Leads' && <LeadsTab campaignId={campaign.id} />}
        {tab === 'Settings' && <SettingsTab campaignId={campaign.id} />}
      </div>
    </div>
  );
}

function OverviewTab({ campaign }: { campaign: CampaignDetail }): JSX.Element {
  const { hasPermission } = useAuth();
  const [showLaunch, setShowLaunch] = useState(false);
  const preflightQuery = useCampaignPreflight(showLaunch ? campaign.id : undefined);
  const start = useCampaignLifecycleAction('start');
  const pause = useCampaignLifecycleAction('pause');
  const resume = useCampaignLifecycleAction('resume');
  const stop = useCampaignLifecycleAction('stop');
  const updateConcurrency = useUpdateConcurrency();
  const [concurrencyDraft, setConcurrencyDraft] = useState(campaign.concurrency_limit);

  const counts = campaign.counts;
  const called = counts.total - counts.pending - counts.retry_pending;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Total leads" value={counts.total} />
        <StatTile label="Called" value={called} />
        <StatTile label="Remaining" value={counts.pending + counts.retry_pending} />
        <StatTile label="Connected" value={counts.connected + counts.completed} />
        <StatTile label="Active calls" value={counts.active_calls} />
        <StatTile label="DNC" value={counts.dnc} />
      </div>

      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Concurrency</h3>
        <p className="mt-1 text-xs text-ink-500">Live adjustment while running - changes are audit logged.</p>
        <div className="mt-3 flex items-center gap-3">
          <Input
            type="number"
            min={1}
            max={500}
            className="w-28"
            value={concurrencyDraft}
            onChange={(e) => setConcurrencyDraft(Number(e.target.value))}
            disabled={!hasPermission('campaigns.edit')}
          />
          <Button
            variant="secondary"
            disabled={updateConcurrency.isPending || concurrencyDraft === campaign.concurrency_limit}
            onClick={() => updateConcurrency.mutate({ id: campaign.id, concurrency_limit: concurrencyDraft })}
          >
            Save
          </Button>
          <span className="text-xs text-ink-500">Currently {counts.active_calls} active of {campaign.concurrency_limit} configured.</span>
        </div>
      </Card>

      {hasPermission('campaigns.start') && (
        <div className="flex flex-wrap gap-2">
          {['draft', 'scheduled', 'paused'].includes(campaign.status) &&
            (campaign.status === 'paused' ? (
              <Button onClick={() => resume.mutate(campaign.id)} disabled={resume.isPending}>
                Resume campaign
              </Button>
            ) : (
              <Button onClick={() => setShowLaunch(true)}>Start campaign</Button>
            ))}
          {campaign.status === 'running' && (
            <Button variant="secondary" onClick={() => pause.mutate(campaign.id)} disabled={pause.isPending}>
              Pause
            </Button>
          )}
          {['running', 'paused', 'scheduled'].includes(campaign.status) && (
            <Button variant="danger" onClick={() => stop.mutate(campaign.id)} disabled={stop.isPending}>
              Stop
            </Button>
          )}
        </div>
      )}

      {showLaunch && (
        <PreLaunchModal
          campaign={campaign}
          preflight={preflightQuery.data}
          isStarting={start.isPending}
          onClose={() => setShowLaunch(false)}
          onConfirm={() => start.mutate(campaign.id, { onSuccess: () => setShowLaunch(false) })}
        />
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink-900">{value}</p>
    </Card>
  );
}

const PROMPT_VARIABLES = ['first_name', 'last_name', 'company', 'phone', 'city', 'state'];

function ConfigurationTab({ campaign }: { campaign: CampaignDetail }): JSX.Element {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('campaigns.edit') && campaign.status !== 'running';
  const updateCampaign = useUpdateCampaign();
  const createVersion = useCreateCampaignVersion();
  const publishVersion = usePublishCampaignVersion();
  const agentsQuery = useAgents(1, 100);
  const voicesQuery = useVoices();
  const scriptsQuery = useScripts();

  const v = campaign.current_version;
  const [prompt, setPrompt] = useState(v?.prompt ?? '');
  const [agentId, setAgentId] = useState(v?.ai_agent_id ?? '');
  const [voiceId, setVoiceId] = useState(v?.voice_id ?? '');
  const [scriptId, setScriptId] = useState(v?.script_id ?? '');
  const [kbIds, setKbIds] = useState<string[]>(v?.knowledge_base_ids ?? []);
  const [transferNumber, setTransferNumber] = useState(campaign.transfer_number_e164 ?? '');
  const [voicemailEnabled, setVoicemailEnabled] = useState(campaign.voicemail_detection_enabled);
  const [voicemailMessage, setVoicemailMessage] = useState(campaign.voicemail_message ?? '');
  const [leaveVoicemail, setLeaveVoicemail] = useState(campaign.leave_voicemail);
  const [cooldown, setCooldown] = useState(campaign.lead_cooldown_minutes);
  const [backgroundNoise, setBackgroundNoise] = useState(campaign.background_noise ?? '');
  const [callingWindowStart, setCallingWindowStart] = useState(campaign.calling_window_start.slice(0, 5));
  const [callingWindowEnd, setCallingWindowEnd] = useState(campaign.calling_window_end.slice(0, 5));
  const [callingDays, setCallingDays] = useState<number[]>(campaign.calling_days);
  const [timezone, setTimezone] = useState(campaign.timezone);
  const [error, setError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState<{ id: string } | null>(null);

  const kbQuery = useKnowledgeBases(agentId || undefined);

  function toggleDay(day: number) {
    setCallingDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  }

  async function handleSaveCampaignFields() {
    setError(null);
    try {
      await updateCampaign.mutateAsync({
        id: campaign.id,
        transfer_number_e164: transferNumber || null,
        voicemail_detection_enabled: voicemailEnabled,
        voicemail_message: voicemailMessage || null,
        leave_voicemail: leaveVoicemail,
        lead_cooldown_minutes: cooldown,
        background_noise: backgroundNoise || null,
        calling_window_start: callingWindowStart,
        calling_window_end: callingWindowEnd,
        calling_days: callingDays,
        timezone,
      });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save campaign fields.');
    }
  }

  async function handleSaveDraftVersion() {
    setError(null);
    try {
      const version = await createVersion.mutateAsync({
        id: campaign.id,
        prompt,
        ai_agent_id: agentId || null,
        voice_id: voiceId || null,
        script_id: scriptId || null,
        knowledge_base_ids: kbIds,
        transfer_number_e164: transferNumber || null,
        calling_rules: { timezone, calling_window_start: callingWindowStart, calling_window_end: callingWindowEnd, calling_days: callingDays },
      });
      setSavedDraft({ id: version.id });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save draft version.');
    }
  }

  async function handlePublish(versionId: string) {
    setError(null);
    try {
      await publishVersion.mutateAsync({ id: campaign.id, versionId });
      setSavedDraft(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to publish version.');
    }
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {v && (
        <Alert variant="info">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4" />
            Current published version: v{v.version_number}, published {v.published_at ? new Date(v.published_at).toLocaleString() : 'never'}. Editing below and saving creates a NEW draft version - it does not change what's currently running.
          </div>
        </Alert>
      )}

      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Script / prompt</h3>
        <p className="mt-1 text-xs text-ink-500">Use {'{{variable}}'} placeholders - click to insert.</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PROMPT_VARIABLES.map((variable) => (
            <button
              key={variable}
              type="button"
              className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-700 hover:bg-ink-200"
              onClick={() => setPrompt((p) => `${p}{{${variable}}}`)}
              disabled={!canEdit}
            >
              {`{{${variable}}}`}
            </button>
          ))}
        </div>
        <textarea
          className="mt-3 w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={!canEdit}
        />
      </Card>

      <Card className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>AI agent</Label>
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={!canEdit}>
            <option value="">Select an agent</option>
            {(agentsQuery.data?.data ?? []).map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Voice</Label>
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!canEdit}>
            <option value="">Use agent's own voice</option>
            {(voicesQuery.data?.data ?? []).map((voice: any) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Script</Label>
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={scriptId} onChange={(e) => setScriptId(e.target.value)} disabled={!canEdit}>
            <option value="">None</option>
            {(scriptsQuery.data?.data ?? []).map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Knowledge base documents</Label>
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2">
            {!agentId && <p className="text-xs text-ink-400">Select an agent first.</p>}
            {(kbQuery.data ?? []).map((kb: any) => (
              <label key={kb.id} className="flex items-center gap-2 text-xs text-ink-700">
                <input
                  type="checkbox"
                  checked={kbIds.includes(kb.id)}
                  disabled={!canEdit}
                  onChange={(e) => setKbIds((prev) => (e.target.checked ? [...prev, kb.id] : prev.filter((id) => id !== kb.id)))}
                />
                {kb.name}
              </label>
            ))}
          </div>
        </div>
      </Card>

      <Card className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Transfer number (E.164)</Label>
          <Input value={transferNumber} onChange={(e) => setTransferNumber(e.target.value)} placeholder="+14155550123" disabled={!canEdit} />
        </div>
        <div>
          <Label>Lead cooldown</Label>
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} disabled={!canEdit}>
            {LEAD_COOLDOWN_PRESETS.map((p) => (
              <option key={p.minutes} value={p.minutes}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Background noise</Label>
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={backgroundNoise} onChange={(e) => setBackgroundNoise(e.target.value)} disabled={!canEdit}>
            <option value="">Off</option>
            {BACKGROUND_NOISE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Timezone</Label>
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/New_York" disabled={!canEdit} />
        </div>
        <div>
          <Label>Calling window</Label>
          <div className="flex items-center gap-2">
            <Input type="time" value={callingWindowStart} onChange={(e) => setCallingWindowStart(e.target.value)} disabled={!canEdit} />
            <span className="text-ink-400">to</span>
            <Input type="time" value={callingWindowEnd} onChange={(e) => setCallingWindowEnd(e.target.value)} disabled={!canEdit} />
          </div>
        </div>
        <div>
          <Label>Calling days</Label>
          <div className="flex flex-wrap gap-1.5">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, idx) => {
              const day = idx + 1;
              const active = callingDays.includes(day);
              return (
                <button
                  key={label}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => toggleDay(day)}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${active ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" checked={voicemailEnabled} onChange={(e) => setVoicemailEnabled(e.target.checked)} disabled={!canEdit} />
          <Label className="mb-0">Voicemail detection enabled</Label>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" checked={leaveVoicemail} onChange={(e) => setLeaveVoicemail(e.target.checked)} disabled={!canEdit} />
          <Label className="mb-0">Leave a voicemail message</Label>
        </div>
        {leaveVoicemail && (
          <div className="sm:col-span-2">
            <Label>Voicemail message</Label>
            <textarea
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm"
              rows={2}
              value={voicemailMessage}
              onChange={(e) => setVoicemailMessage(e.target.value)}
              disabled={!canEdit}
            />
          </div>
        )}
      </Card>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={handleSaveCampaignFields} disabled={updateCampaign.isPending}>
            Save calling/voicemail settings
          </Button>
          <Button onClick={handleSaveDraftVersion} disabled={createVersion.isPending}>
            Save as new draft version
          </Button>
          {savedDraft && (
            <Button variant="primary" onClick={() => handlePublish(savedDraft.id)} disabled={publishVersion.isPending}>
              Publish this draft (snapshots config now)
            </Button>
          )}
        </div>
      )}
      {campaign.status === 'running' && <Alert variant="info">Pause this campaign to edit its configuration.</Alert>}
    </div>
  );
}

function LeadsTab({ campaignId }: { campaignId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const leadsQuery = useCampaignLeads(campaignId, page, 25, statusFilter || undefined);
  const leadListsQuery = useLeadLists();
  const attachLeads = useAttachLeads();
  const rotateLeads = useRotateLeads();
  const [selectedListId, setSelectedListId] = useState('');
  const [rotatePreview, setRotatePreview] = useState<{ rotated: number; excluded: number; decisions: RotateDecision[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = leadsQuery.data?.data ?? [];
  const pagination = leadsQuery.data?.pagination;

  async function handleAttach() {
    if (!selectedListId) return;
    setError(null);
    try {
      await attachLeads.mutateAsync({ id: campaignId, lead_list_id: selectedListId });
      setSelectedListId('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to attach lead list.');
    }
  }

  async function handlePreviewRotate() {
    const result = await rotateLeads.mutateAsync({ id: campaignId, dry_run: true });
    setRotatePreview(result);
  }

  async function handleConfirmRotate() {
    await rotateLeads.mutateAsync({ id: campaignId, dry_run: false });
    setRotatePreview(null);
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {hasPermission('campaigns.edit') && (
        <Card className="flex flex-wrap items-end gap-3">
          <div>
            <Label>Attach a lead list</Label>
            <select className="w-64 rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={selectedListId} onChange={(e) => setSelectedListId(e.target.value)}>
              <option value="">Select a list</option>
              {(leadListsQuery.data?.data ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.lead_count} leads)
                </option>
              ))}
            </select>
          </div>
          <Button onClick={handleAttach} disabled={!selectedListId || attachLeads.isPending}>
            Attach
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={handlePreviewRotate} disabled={rotateLeads.isPending}>
              <ArrowLeftRight className="h-4 w-4" /> Preview rotate/reuse
            </Button>
          </div>
        </Card>
      )}

      {rotatePreview && (
        <Card>
          <h3 className="text-sm font-semibold text-ink-900">Rotate preview</h3>
          <p className="mt-1 text-sm text-ink-600">
            {rotatePreview.rotated} lead(s) will be re-queued for another attempt. {rotatePreview.excluded} lead(s) are excluded (already completed, transferred, DNC, or another permanent outcome).
          </p>
          <div className="mt-3 max-h-48 overflow-y-auto rounded-md border border-ink-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-ink-50 text-ink-500">
                <tr>
                  <th className="px-2 py-1">Lead</th>
                  <th className="px-2 py-1">Include</th>
                  <th className="px-2 py-1">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rotatePreview.decisions.slice(0, 100).map((d) => (
                  <tr key={d.campaignLeadId} className="border-t border-ink-100">
                    <td className="px-2 py-1 font-mono">{d.leadId.slice(0, 8)}</td>
                    <td className="px-2 py-1">
                      <Badge tone={d.include ? 'success' : 'neutral'}>{d.include ? 'Include' : 'Exclude'}</Badge>
                    </td>
                    <td className="px-2 py-1 text-ink-600">{d.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRotatePreview(null)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmRotate} disabled={rotateLeads.isPending}>
              Confirm - re-queue {rotatePreview.rotated} lead(s)
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-900">Attached leads</h3>
          <select className="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {['pending', 'queued', 'dialing', 'connected', 'completed', 'retry_pending', 'failed', 'skipped', 'dnc'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="text-ink-500">
            <tr>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Phone</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Disposition</th>
              <th className="px-2 py-1">Attempts</th>
              <th className="px-2 py-1">Next eligible</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-ink-100">
                <td className="px-2 py-1">{row.leads ? `${row.leads.first_name} ${row.leads.last_name}` : '-'}</td>
                <td className="px-2 py-1">{row.leads?.phone_normalized ?? '-'}</td>
                <td className="px-2 py-1">
                  <Badge>{row.status}</Badge>
                </td>
                <td className="px-2 py-1">
                  {row.final_disposition ? <Badge tone="neutral">{row.final_disposition}</Badge> : <span className="text-ink-400">-</span>}
                </td>
                <td className="px-2 py-1">{row.attempt_count}</td>
                <td className="px-2 py-1">{row.next_eligible_at ? new Date(row.next_eligible_at).toLocaleString() : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pagination && pagination.total_pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span>
              Page {pagination.page} of {pagination.total_pages}
            </span>
            <Button variant="ghost" disabled={page >= pagination.total_pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function SettingsTab({ campaignId }: { campaignId: string }): JSX.Element {
  const [key, setKey] = useState('amd_sensitivity');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { hasPermission } = useAuth();

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      await api.post(`/campaigns/${campaignId}/settings`, { key, value });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save setting.');
    }
  }

  return (
    <Card className="max-w-lg space-y-4">
      <h3 className="text-sm font-semibold text-ink-900">Per-campaign dialing overrides</h3>
      <p className="text-xs text-ink-500">Overrides the organization's default dialing settings for this campaign only (e.g. AMD sensitivity, retry policy).</p>
      {error && <Alert>{error}</Alert>}
      {saved && <Alert variant="success">Setting saved.</Alert>}
      <div>
        <Label>Key</Label>
        <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={key} onChange={(e) => setKey(e.target.value)}>
          <option value="amd_sensitivity">AMD sensitivity</option>
          <option value="retry_delay_override_minutes">Retry delay override (minutes)</option>
          <option value="busy_behavior">Busy behavior</option>
          <option value="no_answer_behavior">No-answer behavior</option>
        </select>
      </div>
      <div>
        <Label>Value</Label>
        <Input value={value} onChange={(e) => setValue(e.target.value)} disabled={!hasPermission('campaigns.edit')} />
      </div>
      <Button onClick={handleSave} disabled={!hasPermission('campaigns.edit')}>
        Save override
      </Button>
    </Card>
  );
}
