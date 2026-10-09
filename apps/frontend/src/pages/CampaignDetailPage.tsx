import { hideVendorName } from '../lib/displayText';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Info, Trash2 } from 'lucide-react';
import {
  CAMPAIGN_STATUS_LABELS,
  LEAD_COOLDOWN_PRESETS,
  PROMPT_VARIABLES,
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
  useRemoveLeads,
  useSetCampaignPhoneNumbers,
  useUpdateCampaign,
  useUpdateConcurrency,
  type CampaignDetail,
} from '../hooks/useCampaigns';
import { useAgents } from '../hooks/useAgents';
import { usePhoneNumbers } from '../hooks/usePhoneNumbers';
import { useVoices } from '../hooks/useVoices';
import { useKnowledgeBases } from '../hooks/useKnowledgeBases';
import { useScripts } from '../hooks/useScripts';
import { useLeadLists } from '../hooks/useLeadLists';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { PreLaunchModal } from '../components/campaigns/PreLaunchModal';
import { api, describeApiError } from '../lib/apiClient';
import { handlePlaceholderPaste } from '../lib/placeholderPaste';
import { VoiceSelect } from '../components/VoiceSelect';
import { RowCheckbox, SelectPageCheckbox, SelectionBar } from '../components/SelectionBar';
import { useRowSelection } from '../hooks/useRowSelection';

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
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const initialTab: Tab = (TABS as readonly string[]).includes(requestedTab ?? '') ? (requestedTab as Tab) : 'Overview';
  const [tab, setTab] = useState<Tab>(initialTab);
  const campaignQuery = useCampaign(id);
  const campaign = campaignQuery.data;

  function selectTab(t: Tab) {
    setTab(t);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', t);
      return next;
    }, { replace: true });
  }

  if (campaignQuery.isLoading || !campaign) {
    return <p className="text-sm text-ink-500">Loading campaign...</p>;
  }

  return (
    <div>
      <Link to="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-700">
        <ArrowLeft className="h-4 w-4" /> Back to campaigns
      </Link>

      <div className="mt-3 flex items-center justify-between">
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
              onClick={() => selectTab(t)}
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
  const restart = useCampaignLifecycleAction('restart');
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
          {['stopped', 'completed', 'failed'].includes(campaign.status) && (
            <Button onClick={() => restart.mutate(campaign.id)} disabled={restart.isPending}>
              Restart campaign
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

function ConfigurationTab({ campaign }: { campaign: CampaignDetail }): JSX.Element {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('campaigns.edit') && campaign.status !== 'running';
  const updateCampaign = useUpdateCampaign();
  const setPhoneNumbers = useSetCampaignPhoneNumbers();
  const createVersion = useCreateCampaignVersion();
  const publishVersion = usePublishCampaignVersion();
  const pause = useCampaignLifecycleAction('pause');
  const agentsQuery = useAgents(1, 100);
  const phoneNumbersQuery = usePhoneNumbers({ status: 'active' });
  const voicesQuery = useVoices();
  const scriptsQuery = useScripts();

  // A saved-but-unpublished draft never showed up here at all: the GET
  // only ever returned current_version (the last PUBLISHED version - see
  // routes/campaigns.ts), so reopening this tab after "Save draft" looked
  // like the draft's contents had vanished. draft_version is the fix -
  // prefer it over the published version whenever one exists.
  const v = campaign.draft_version ?? campaign.current_version;
  const [prompt, setPrompt] = useState(v?.prompt ?? '');
  const [agentId, setAgentId] = useState(v?.ai_agent_id ?? '');
  const [phoneNumberIds, setPhoneNumberIds] = useState<string[]>(campaign.phone_numbers.map((p) => p.id));
  const [voiceId, setVoiceId] = useState(v?.voice_id ?? '');
  const [scriptId, setScriptId] = useState(v?.script_id ?? '');
  const [kbIds, setKbIds] = useState<string[]>(v?.knowledge_base_ids ?? []);
  const [transferNumber, setTransferNumber] = useState(campaign.transfer_number_e164 ?? '');
  const [introName, setIntroName] = useState(campaign.intro_name ?? '');
  const [voicemailEnabled, setVoicemailEnabled] = useState(campaign.voicemail_detection_enabled);
  const [voicemailMessage, setVoicemailMessage] = useState(campaign.voicemail_message ?? '');
  const [leaveVoicemail, setLeaveVoicemail] = useState(campaign.leave_voicemail);
  const [cooldown, setCooldown] = useState(campaign.lead_cooldown_minutes);
  const [callingWindowStart, setCallingWindowStart] = useState(campaign.calling_window_start.slice(0, 5));
  const [callingWindowEnd, setCallingWindowEnd] = useState(campaign.calling_window_end.slice(0, 5));
  const [callingDays, setCallingDays] = useState<number[]>(campaign.calling_days);
  const [timezone, setTimezone] = useState(campaign.timezone);
  const [error, setError] = useState<string | null>(null);
  const [promptPlaceholderNotice, setPromptPlaceholderNotice] = useState<string | null>(null);

  const kbQuery = useKnowledgeBases(agentId || undefined);

  const versionId = v?.id;
  useEffect(() => {
    // Re-sync the form when which version is actually active changes
    // (e.g. a draft just got created/loaded, or was published and
    // archived) - deliberately keyed on the version id, not the campaign
    // object itself, since this query polls every 5s for live counts and
    // would otherwise wipe out in-progress edits on every refetch.
    setPrompt(v?.prompt ?? '');
    setAgentId(v?.ai_agent_id ?? '');
    setVoiceId(v?.voice_id ?? '');
    setScriptId(v?.script_id ?? '');
    setKbIds(v?.knowledge_base_ids ?? []);
  }, [versionId]);

  function toggleDay(day: number) {
    setCallingDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  }

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  /** Per request ("one button to publish all changes"): everything on this
   * tab is saved and made live by this single button - campaign settings,
   * introduction name, phone numbers, and a new published version with the
   * prompt/agent/voice/script/knowledge base and calling/voicemail rules. */
  async function handleSaveAndPublish() {
    setError(null);
    setSaving(true);
    try {
      await updateCampaign.mutateAsync({
        id: campaign.id,
        transfer_number_e164: transferNumber || null,
        voicemail_detection_enabled: voicemailEnabled,
        voicemail_message: voicemailMessage || null,
        leave_voicemail: leaveVoicemail,
        lead_cooldown_minutes: cooldown,
        calling_window_start: callingWindowStart,
        calling_window_end: callingWindowEnd,
        calling_days: callingDays,
        timezone,
        intro_name: introName.trim() || null,
      });
      const currentNumbers = campaign.phone_numbers.map((p) => p.id).sort().join(',');
      if ([...phoneNumberIds].sort().join(',') !== currentNumbers) {
        await setPhoneNumbers.mutateAsync({ id: campaign.id, phoneNumberIds });
      }
      const version = await createVersion.mutateAsync({
        id: campaign.id,
        prompt,
        ai_agent_id: agentId || null,
        voice_id: voiceId || null,
        script_id: scriptId || null,
        knowledge_base_ids: kbIds,
        transfer_number_e164: transferNumber || null,
        calling_rules: {
          timezone,
          calling_window_start: callingWindowStart,
          calling_window_end: callingWindowEnd,
          calling_days: callingDays,
          lead_cooldown_minutes: cooldown,
          voicemail_detection_enabled: voicemailEnabled,
          voicemail_message: voicemailMessage || null,
          leave_voicemail: leaveVoicemail,
        },
      });
      await publish(version.id);
    } catch (err) {
      setError(describeApiError(err, 'Failed to save and publish the campaign.'));
    } finally {
      setSaving(false);
    }
  }

  async function publish(versionId: string) {
    try {
      await publishVersion.mutateAsync({ id: campaign.id, versionId });
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      // The linked AI agent has an unpublished draft (e.g. a model switch
      // never published) - publishing now would lock in the agent's older
      // config. Ask rather than fail.
      const details = (err as { details?: { code?: string; agentDraftVersionNumber?: number } } | undefined)?.details;
      if (details?.code !== 'STALE_AGENT_DRAFT') throw err;
      const proceed = window.confirm(
        `The AI agent linked to this campaign has unpublished changes (v${details.agentDraftVersionNumber}), for example a model switch. ` +
          "Publishing now uses the agent's older published setup. Click Cancel to publish the agent first (recommended), or OK to publish this campaign anyway.",
      );
      if (!proceed) return;
      await publishVersion.mutateAsync({ id: campaign.id, versionId, acknowledgeStaleAgentDraft: true });
      setSavedAt(new Date().toLocaleTimeString());
    }
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {campaign.status === 'running' && hasPermission('campaigns.edit') && (
        <Alert variant="info">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>This campaign is running, so its configuration is locked. Pause it to make changes.</span>
            <Button variant="secondary" disabled={pause.isPending} onClick={() => pause.mutate(campaign.id)}>
              {pause.isPending ? 'Pausing...' : 'Pause to edit'}
            </Button>
          </div>
        </Alert>
      )}

      {campaign.draft_version ? (
        <Alert variant="info">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4" />
            Showing your saved draft (v{campaign.draft_version.version_number}) - it's not live yet. Click <strong>Save &amp; publish</strong> to make it live.
          </div>
        </Alert>
      ) : (
        campaign.current_version && (
          <Alert variant="info">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4" />
              Current published version: v{campaign.current_version.version_number}, published{' '}
              {campaign.current_version.published_at ? new Date(campaign.current_version.published_at).toLocaleString() : 'never'}. Change anything below
              and click <strong>Save &amp; publish</strong> - calls use it from the next one.
            </div>
          </Alert>
        )
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
          onPaste={(e) => handlePlaceholderPaste(e, prompt, setPrompt, setPromptPlaceholderNotice)}
          disabled={!canEdit}
        />
        {promptPlaceholderNotice && <p className="mt-1.5 text-xs text-ink-500">{promptPlaceholderNotice}</p>}
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
          <Label>Outbound phone numbers</Label>
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2">
            {(phoneNumbersQuery.data?.data ?? []).length === 0 && (
              <p className="text-xs text-ink-400">No active numbers yet - go to DIDs to connect a provider and import/sync a number.</p>
            )}
            {(phoneNumbersQuery.data?.data ?? []).map((n: any) => (
              <label key={n.id} className="flex items-center gap-2 text-xs text-ink-700">
                <input
                  type="checkbox"
                  checked={phoneNumberIds.includes(n.id)}
                  disabled={!canEdit}
                  onChange={(e) => setPhoneNumberIds((prev) => (e.target.checked ? [...prev, n.id] : prev.filter((id) => id !== n.id)))}
                />
                {n.phone_number}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-500">
            Select one or more - any mix of providers works. The dialer rotates across every number checked here.
          </p>
        </div>
        <div>
          <Label>Voice</Label>
          <VoiceSelect value={voiceId} onChange={setVoiceId} emptyLabel="Use agent's own voice" disabled={!canEdit} />
          {(voicesQuery.data?.data ?? []).length === 0 && (
            <p className="mt-1 text-xs text-ink-500">
              No voices registered yet -{' '}
              <Link to="/voices" className="underline">
                connect a voice provider and sync/clone voices
              </Link>
              .
            </p>
          )}
        </div>
        <div>
          <Label>Introduce as</Label>
          <Input value={introName} onChange={(e) => setIntroName(e.target.value)} placeholder={campaign.name} maxLength={200} disabled={!canEdit} />
          <p className="mt-1 text-xs text-ink-500">
            The AI says "this is {'{voice}'} from <strong>{introName.trim() || campaign.name}</strong>". Leave empty to use the campaign name.
          </p>
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
          <p className="mt-1 text-xs text-ink-500">
            <Link to="/scripts" className="underline">
              Upload or write a new script
            </Link>
            , then select it here.
          </p>
        </div>
        <div>
          <Label>Knowledge base / SOP documents</Label>
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2">
            {!agentId && <p className="text-xs text-ink-400">Select an agent first.</p>}
            {agentId && (kbQuery.data ?? []).length === 0 && (
              <p className="text-xs text-ink-400">
                No documents yet -{' '}
                <Link to={`/ai-agents/${agentId}`} className="underline">
                  upload SOP/knowledge base documents on the agent's page
                </Link>
                .
              </p>
            )}
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
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-ink-200 bg-white/95 py-3">
          <Button onClick={handleSaveAndPublish} disabled={saving}>
            {saving ? 'Publishing...' : 'Save & publish'}
          </Button>
          <span className="text-xs text-ink-500">
            {savedAt ? `Published at ${savedAt} - new calls use these settings.` : 'Saves every change on this page and makes it live for the next call.'}
          </span>
        </div>
      )}
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
  const removeLeads = useRemoveLeads();
  const [selectedListId, setSelectedListId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const rows = leadsQuery.data?.data ?? [];
  const pagination = leadsQuery.data?.pagination;
  const canEdit = hasPermission('campaigns.edit');
  const selection = useRowSelection(rows.map((r) => r.id), statusFilter);
  const selectedCount = selection.allMatching ? pagination?.total ?? 0 : selection.selected.size;

  async function handleAttach() {
    if (!selectedListId) return;
    setError(null);
    try {
      await attachLeads.mutateAsync({ id: campaignId, lead_list_id: selectedListId });
      setSelectedListId('');
    } catch (err) {
      setError(describeApiError(err, 'Failed to attach lead list.'));
    }
  }

  async function handleRemoveSelected() {
    setError(null);
    setNotice(null);
    try {
      const result = await removeLeads.mutateAsync(
        selection.allMatching
          ? { id: campaignId, all_matching: true, status: statusFilter || undefined }
          : { id: campaignId, campaign_lead_ids: Array.from(selection.selected) },
      );
      selection.clear();
      setConfirmingRemove(false);
      setNotice(
        result.skipped_active > 0
          ? `${result.removed} lead(s) removed. ${result.skipped_active} skipped - on an active call right now.`
          : `${result.removed} lead(s) removed from this campaign.`,
      );
    } catch (err) {
      setError(describeApiError(err, 'Failed to remove the selected leads.'));
    }
  }

  async function handleRemove(leadId: string) {
    if (!window.confirm('Remove this lead from the campaign? It will not be dialed again unless re-attached.')) return;
    setError(null);
    try {
      await removeLeads.mutateAsync({ id: campaignId, lead_ids: [leadId] });
    } catch (err) {
      setError(describeApiError(err, 'Failed to remove this lead.'));
    }
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert variant="success">{notice}</Alert>}

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

          <p className="ml-auto max-w-sm text-xs text-ink-500">
            Never-dialed leads are called first. To redial leads, reset them from{' '}
            <Link to="/lead-lists" className="underline">
              Lead Lists
            </Link>
            .
          </p>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-900">Attached leads</h3>
          <select
            className="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-xs"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All leads</option>
            <option value="fresh">Fresh (never dialed)</option>
            <option value="dialed">Already dialed</option>
            {['pending', 'queued', 'dialing', 'connected', 'completed', 'retry_pending', 'failed', 'skipped', 'dnc'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {canEdit && (
          <div className="mb-3 -mt-1">
            <SelectionBar selection={selection} pageCount={rows.length} total={pagination?.total ?? rows.length} noun="leads">
              {confirmingRemove ? (
                <>
                  <span className="text-xs text-ink-600">Remove {selectedCount} lead(s) from this campaign?</span>
                  <Button variant="danger" disabled={removeLeads.isPending} onClick={handleRemoveSelected}>
                    {removeLeads.isPending ? 'Removing...' : 'Confirm'}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="danger" onClick={() => setConfirmingRemove(true)}>
                  <Trash2 className="h-4 w-4" /> Remove selected
                </Button>
              )}
            </SelectionBar>
          </div>
        )}
        <table className="w-full text-left text-xs">
          <thead className="text-ink-500">
            <tr>
              {canEdit && (
                <th className="w-8 px-2 py-1">
                  <SelectPageCheckbox selection={selection} label="Select all leads on this page" />
                </th>
              )}
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Phone</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Disposition</th>
              <th className="px-2 py-1">Attempts</th>
              <th className="px-2 py-1">Next eligible</th>
              {hasPermission('campaigns.edit') && <th className="px-2 py-1 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isActive = ['dialing', 'ringing', 'connected', 'in_progress', 'transferring'].includes(row.status);
              return (
                <tr key={row.id} className="border-t border-ink-100">
                  {canEdit && (
                    <td className="px-2 py-1">
                      <RowCheckbox selection={selection} id={row.id} label={`Select ${row.leads?.phone_normalized ?? 'lead'}`} />
                    </td>
                  )}
                  <td className="px-2 py-1">{row.leads ? `${row.leads.first_name} ${row.leads.last_name}` : '-'}</td>
                  <td className="px-2 py-1">{row.leads?.phone_normalized ?? '-'}</td>
                  <td className="px-2 py-1">
                    <Badge>{row.status}</Badge>
                  </td>
                  <td className="px-2 py-1">
                    {row.final_disposition ? <Badge tone="neutral">{hideVendorName(row.final_disposition)}</Badge> : <span className="text-ink-400">-</span>}
                  </td>
                  <td className="px-2 py-1">{row.attempt_count}</td>
                  <td className="px-2 py-1">{row.next_eligible_at ? new Date(row.next_eligible_at).toLocaleString() : '-'}</td>
                  {hasPermission('campaigns.edit') && (
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        className="text-ink-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => handleRemove(row.lead_id)}
                        disabled={isActive || removeLeads.isPending}
                        title={isActive ? 'This lead is on an active call and cannot be removed right now.' : 'Remove from campaign'}
                        aria-label="Remove from campaign"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
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
      setError(describeApiError(err, 'Failed to save setting.'));
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
