import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import {
  BEHAVIOR_TRAITS,
  EVALUATION_SCORE_CATEGORY_LABELS,
  LLM_MODEL_OPTIONS,
  LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  PERSONALITY_TONES,
  PERSONALITY_TRAITS,
  PROMPT_VARIABLES,
  type AiAgentVersion,
  type LlmProvider,
} from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import {
  useAgentVersions,
  useCreateAgentVersion,
  usePublishAgentVersion,
  useUpdateAgentVersion,
} from '../../hooks/useAgents';
import { useAgentEvaluationSummary } from '../../hooks/useEvaluations';
import { usePreviewVoice, useVoices } from '../../hooks/useVoices';
import { Alert, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError, describeApiError } from '../../lib/apiClient';
import { handlePlaceholderPaste } from '../../lib/placeholderPaste';

const CUSTOM_MODEL_SENTINEL = '__custom__';

/** Model id picker: a real dropdown of the exact model ids Vapi's own
 * docs currently list as supported for the selected provider
 * (LLM_MODEL_OPTIONS - only openai/anthropic have a sourced list right
 * now), with a free-text fallback for every other provider or a model id
 * not on that list (e.g. an older/custom deployment, or a provider Vapi
 * added a model for since this list was last updated). Never silently
 * clears a value that isn't in the curated list - it shows up as
 * "Custom" with the real value still intact in the text field. */
function ModelField({ provider, model, onChange }: { provider: LlmProvider; model: string; onChange: (model: string) => void }): JSX.Element {
  const curated = LLM_MODEL_OPTIONS[provider];
  const isCustom = !curated || !curated.includes(model);

  return (
    <div>
      <Label htmlFor="llm_model">Model</Label>
      {curated && (
        <select
          id="llm_model"
          className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
          value={isCustom ? CUSTOM_MODEL_SENTINEL : model}
          onChange={(e) => {
            if (e.target.value !== CUSTOM_MODEL_SENTINEL) onChange(e.target.value);
          }}
        >
          {curated.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
          <option value={CUSTOM_MODEL_SENTINEL}>Custom (type a model id)...</option>
        </select>
      )}
      {isCustom && (
        <Input
          id={curated ? 'llm_model_custom' : 'llm_model'}
          className={curated ? 'mt-2' : undefined}
          placeholder="e.g. gpt-4o-mini, claude-sonnet-4-6"
          value={model}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p className="mt-1 text-xs text-ink-500">
        {curated
          ? "Sourced from Vapi's own supported-model list for this provider - Vapi rejects an unrecognized model id when placing a call."
          : 'Must be a real model id for the provider above - Vapi rejects an unrecognized one when placing a call.'}
      </p>
    </div>
  );
}

/** Phase 11: the evaluation-summary widget (spec sections 24/86) - real
 * server-aggregated (GROUP BY/AVG) average overall score and per-category
 * averages over the agent's last 30 days of evaluated calls. An honest
 * "no evaluated calls yet" state when call_count is 0 - never a
 * fabricated trend. */
function EvaluationSummaryWidget({ agentId }: { agentId: string }): JSX.Element | null {
  const summaryQuery = useAgentEvaluationSummary(agentId, 30);
  if (summaryQuery.isLoading || summaryQuery.isError || !summaryQuery.data) return null;
  const summary = summaryQuery.data;

  if (summary.call_count === 0) {
    return (
      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Call quality (last 30 days)</h3>
        <p className="mt-2 text-sm text-ink-500">No calls have been evaluated for this agent in the last 30 days yet.</p>
      </Card>
    );
  }

  const categoryEntries = Object.entries(summary.category_averages) as [keyof typeof EVALUATION_SCORE_CATEGORY_LABELS, number][];

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-900">Call quality (last 30 days)</h3>
        <span className="text-xs text-ink-500">{summary.call_count} evaluated call{summary.call_count === 1 ? '' : 's'}</span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="text-3xl font-semibold text-ink-900">
          {summary.average_overall_score != null ? Math.round(summary.average_overall_score) : '-'}
        </span>
        <span className="text-xs text-ink-500">/ 100 average overall score</span>
      </div>
      {categoryEntries.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          {categoryEntries.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between text-xs">
              <span className="text-ink-600">{EVALUATION_SCORE_CATEGORY_LABELS[key] ?? key}</span>
              <span className="font-medium text-ink-900">{Math.round(value)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function VariablePalette(): JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {PROMPT_VARIABLES.map((v) => (
        <code
          key={v}
          className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600"
          title="Click to copy"
          onClick={() => navigator.clipboard?.writeText(`{{${v}}}`).catch(() => undefined)}
        >
          {`{{${v}}}`}
        </code>
      ))}
    </div>
  );
}

function TogglePills({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            onClick={() => onToggle(option)}
            className={
              active
                ? 'rounded-full bg-ink-900 px-3 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-ink-300 bg-white px-3 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50'
            }
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** Real voice picker for the agent's voice_id, replacing Phase 3's bare
 * text field - pulls this org's own registered voices (Phase 4) with a
 * preview play button. Voices are only usable once actually registered
 * (synced or cloned) under the Voices page. */
function VoicePicker({ value, onChange }: { value: string; onChange: (voiceId: string) => void }): JSX.Element {
  const voicesQuery = useVoices({ status: 'active' });
  const voices = voicesQuery.data?.data ?? [];
  const preview = usePreviewVoice();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const apiOrigin = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(/\/api\/v1\/?$/, '');

  async function handlePreview() {
    if (!value) return;
    setPreviewError(null);
    try {
      const result = await preview.mutateAsync({ id: value });
      const url = result.url.startsWith('http') ? result.url : `${apiOrigin}${result.url}`;
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } catch (err) {
      setPreviewError(err instanceof ApiClientError ? err.message : 'Could not generate a preview.');
    }
  }

  return (
    <div>
      <Label htmlFor="voice_id">Voice</Label>
      {voices.length === 0 && !voicesQuery.isLoading && (
        <p className="mb-1.5 text-xs text-ink-500">
          No voices registered yet - add and sync a provider, or clone a voice, on the Voices page.
        </p>
      )}
      <div className="flex items-center gap-2">
        <select
          id="voice_id"
          className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">No voice selected</option>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.provider_key}{v.requires_external_hosting ? ', self-hosted' : ''})
            </option>
          ))}
        </select>
        <Button type="button" variant="secondary" disabled={!value || preview.isPending} onClick={handlePreview}>
          <Play className="h-3.5 w-3.5" /> {preview.isPending ? '...' : 'Preview'}
        </Button>
      </div>
      <audio ref={audioRef} className="hidden" />
      {previewError && <p className="mt-1 text-xs text-red-600">{previewError}</p>}
    </div>
  );
}

interface DraftForm {
  tone: string | null;
  personality_traits: string[];
  behavior_traits: string[];
  language: string;
  accent: string;
  greeting_template: string;
  system_prompt: string;
  fallback_behavior: string;
  llm_provider: string;
  llm_model: string;
  llm_temperature: number;
  llm_max_tokens: number;
  voice_id: string;
  transfer_on_no_match: 'end_call' | 'transfer' | 'voicemail';
  transfer_to: string;
  max_call_duration_seconds: string;
}

function formFromVersion(v: AiAgentVersion | null): DraftForm {
  return {
    tone: v?.personality?.tone ?? null,
    personality_traits: v?.personality?.personality_traits ?? [],
    behavior_traits: v?.personality?.behavior_traits ?? [],
    language: v?.language ?? 'en-US',
    accent: v?.accent ?? '',
    greeting_template: v?.greeting_template ?? '',
    system_prompt: v?.system_prompt ?? '',
    fallback_behavior: v?.fallback_behavior ?? '',
    llm_provider: v?.llm_provider ?? 'openai',
    llm_model: v?.llm_model ?? 'gpt-4o-mini',
    llm_temperature: v?.llm_temperature ?? 0.7,
    llm_max_tokens: v?.llm_max_tokens ?? 800,
    voice_id: v?.voice_id ?? '',
    transfer_on_no_match: v?.transfer_rules?.on_no_match ?? 'end_call',
    transfer_to: v?.transfer_rules?.transfer_to ?? '',
    max_call_duration_seconds: v?.call_ending_rules?.max_call_duration_seconds
      ? String(v.call_ending_rules.max_call_duration_seconds)
      : '',
  };
}

function toPayload(form: DraftForm) {
  return {
    personality: {
      tone: form.tone,
      personality_traits: form.personality_traits,
      behavior_traits: form.behavior_traits,
    },
    language: form.language,
    accent: form.accent || null,
    greeting_template: form.greeting_template,
    system_prompt: form.system_prompt,
    fallback_behavior: form.fallback_behavior || null,
    llm_provider: form.llm_provider,
    llm_model: form.llm_model,
    llm_temperature: form.llm_temperature,
    llm_max_tokens: form.llm_max_tokens,
    voice_id: form.voice_id || null,
    transfer_rules: {
      on_no_match: form.transfer_on_no_match,
      transfer_to: form.transfer_to || null,
      conditions: [],
    },
    call_ending_rules: {
      max_call_duration_seconds: form.max_call_duration_seconds ? Number(form.max_call_duration_seconds) : null,
      end_phrases: [],
      summarize_before_ending: true,
    },
  };
}

export function ConfigurationTab({ agentId }: { agentId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const versionsQuery = useAgentVersions(agentId);
  const createVersion = useCreateAgentVersion(agentId);
  const updateVersion = useUpdateAgentVersion(agentId);
  const publishVersion = usePublishAgentVersion(agentId);

  const versions = versionsQuery.data ?? [];
  const draft = versions.find((v) => v.status === 'draft') ?? null;
  const published = versions.find((v) => v.status === 'published') ?? null;

  const [form, setForm] = useState<DraftForm>(() => formFromVersion(draft ?? published));
  const [error, setError] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [greetingPlaceholderNotice, setGreetingPlaceholderNotice] = useState<string | null>(null);
  const [promptPlaceholderNotice, setPromptPlaceholderNotice] = useState<string | null>(null);

  const draftId = draft?.id;
  const publishedId = published?.id;
  useEffect(() => {
    setForm(formFromVersion(draft ?? published));
    // Only re-sync the form when which version is active changes, not on
    // every render (the effect intentionally excludes draft/published
    // object identity since a new object is fetched on each query).
  }, [draftId, publishedId]);

  if (versionsQuery.isLoading) return <p className="text-sm text-ink-500">Loading configuration...</p>;

  async function handleSaveDraft() {
    setError(null);
    try {
      if (draft) {
        await updateVersion.mutateAsync({ versionId: draft.id, ...toPayload(form) });
      } else {
        await createVersion.mutateAsync(toPayload(form));
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? describeApiError(err, 'Could not save the draft.') : 'Could not save the draft.');
    }
  }

  async function handlePublish() {
    setError(null);
    try {
      let versionId = draft?.id;
      if (!versionId) {
        const created = await createVersion.mutateAsync(toPayload(form));
        versionId = created.id;
      } else {
        await updateVersion.mutateAsync({ versionId, ...toPayload(form) });
      }
      const published = await publishVersion.mutateAsync(versionId);
      setConfirmPublish(false);
      // The version itself is published either way - but if syncing this
      // config to the actual Vapi assistant failed (e.g. an unrecognized
      // model id, or an expired Vapi key), calls keep using the OLD
      // config until this is fixed. Surface it instead of a silent
      // "Published" that looks identical to a real sync.
      if (published.vapi_sync_error) {
        setError(
          `This version is published, but syncing it to Vapi failed: ${published.vapi_sync_error}. Calls using this agent may still use the previous config until this is resolved.`,
        );
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? describeApiError(err, 'Could not publish this version.') : 'Could not publish this version.');
    }
  }

  const saving = createVersion.isPending || updateVersion.isPending || publishVersion.isPending;

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {published && !draft && (
        <Alert variant="info">
          Editing will create a new draft version {(versions[0]?.version_number ?? 0) + 1}. Version{' '}
          {published.version_number} stays published until you publish the new one.
        </Alert>
      )}

      <EvaluationSummaryWidget agentId={agentId} />

      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Personality</h3>
        <div className="mt-3">
          <Label>Tone</Label>
          <TogglePills
            options={PERSONALITY_TONES}
            selected={form.tone ? [form.tone] : []}
            onToggle={(t) => setForm((f) => ({ ...f, tone: f.tone === t ? null : t }))}
          />
        </div>
        <div className="mt-4">
          <Label>Personality traits</Label>
          <TogglePills
            options={PERSONALITY_TRAITS}
            selected={form.personality_traits}
            onToggle={(t) =>
              setForm((f) => ({
                ...f,
                personality_traits: f.personality_traits.includes(t)
                  ? f.personality_traits.filter((x) => x !== t)
                  : [...f.personality_traits, t],
              }))
            }
          />
        </div>
        <div className="mt-4">
          <Label>Behavior</Label>
          <TogglePills
            options={BEHAVIOR_TRAITS}
            selected={form.behavior_traits}
            onToggle={(t) =>
              setForm((f) => ({
                ...f,
                behavior_traits: f.behavior_traits.includes(t)
                  ? f.behavior_traits.filter((x) => x !== t)
                  : [...f.behavior_traits, t],
              }))
            }
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="language">Language</Label>
            <Input id="language" value={form.language} onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="accent">Accent (optional)</Label>
            <Input id="accent" value={form.accent} onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))} />
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Greeting &amp; system prompt</h3>
        <div className="mt-3">
          <Label htmlFor="greeting">Greeting template</Label>
          <textarea
            id="greeting"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={2}
            value={form.greeting_template}
            onChange={(e) => setForm((f) => ({ ...f, greeting_template: e.target.value }))}
            onPaste={(e) =>
              handlePlaceholderPaste(e, form.greeting_template, (v) => setForm((f) => ({ ...f, greeting_template: v })), setGreetingPlaceholderNotice)
            }
          />
          <VariablePalette />
          {greetingPlaceholderNotice && <p className="mt-1.5 text-xs text-ink-500">{greetingPlaceholderNotice}</p>}
        </div>
        <div className="mt-4">
          <Label htmlFor="system_prompt">System prompt</Label>
          <textarea
            id="system_prompt"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 font-mono text-xs text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={10}
            value={form.system_prompt}
            onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
            onPaste={(e) => handlePlaceholderPaste(e, form.system_prompt, (v) => setForm((f) => ({ ...f, system_prompt: v })), setPromptPlaceholderNotice)}
          />
          <VariablePalette />
          {promptPlaceholderNotice && <p className="mt-1.5 text-xs text-ink-500">{promptPlaceholderNotice}</p>}
        </div>
        <div className="mt-4">
          <Label htmlFor="fallback">Fallback behavior</Label>
          <textarea
            id="fallback"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={2}
            maxLength={20000}
            placeholder="What the agent should do when it doesn't understand the caller"
            value={form.fallback_behavior}
            onChange={(e) => setForm((f) => ({ ...f, fallback_behavior: e.target.value }))}
          />
          <p className={`mt-1 text-right text-xs ${form.fallback_behavior.length > 19000 ? 'text-red-600' : 'text-ink-400'}`}>
            {form.fallback_behavior.length} / 20000
          </p>
        </div>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Transfer &amp; call-ending rules</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="on_no_match">When the agent can't help</Label>
            <select
              id="on_no_match"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={form.transfer_on_no_match}
              onChange={(e) => setForm((f) => ({ ...f, transfer_on_no_match: e.target.value as DraftForm['transfer_on_no_match'] }))}
            >
              <option value="end_call">End the call</option>
              <option value="transfer">Transfer</option>
              <option value="voicemail">Send to voicemail</option>
            </select>
          </div>
          {form.transfer_on_no_match === 'transfer' && (
            <div>
              <Label htmlFor="transfer_to">Transfer to</Label>
              <Input
                id="transfer_to"
                placeholder="Extension, number, or queue"
                value={form.transfer_to}
                onChange={(e) => setForm((f) => ({ ...f, transfer_to: e.target.value }))}
              />
            </div>
          )}
          <div>
            <Label htmlFor="max_duration">Max call duration (seconds, optional)</Label>
            <Input
              id="max_duration"
              type="number"
              min={1}
              value={form.max_call_duration_seconds}
              onChange={(e) => setForm((f) => ({ ...f, max_call_duration_seconds: e.target.value }))}
            />
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-ink-900">LLM settings</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="llm_provider">Provider</Label>
            <select
              id="llm_provider"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={form.llm_provider}
              onChange={(e) => setForm((f) => ({ ...f, llm_provider: e.target.value }))}
            >
              {LLM_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {LLM_PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <ModelField provider={form.llm_provider as LlmProvider} model={form.llm_model} onChange={(model) => setForm((f) => ({ ...f, llm_model: model }))} />
          <div>
            <Label htmlFor="llm_temperature">Temperature</Label>
            <Input
              id="llm_temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.llm_temperature}
              onChange={(e) => {
                // Number(e.target.value) turns a briefly-cleared field
                // ('') into 0 rather than NaN, which could silently save
                // an out-of-range value while the user is still typing a
                // replacement - valueAsNumber correctly reports NaN there.
                // Skip the state update entirely while empty/invalid so
                // the field can still be cleared without snapping back.
                const next = e.target.valueAsNumber;
                if (!Number.isNaN(next)) setForm((f) => ({ ...f, llm_temperature: next }));
              }}
            />
          </div>
          <div>
            <Label htmlFor="llm_max_tokens">Max tokens</Label>
            <Input
              id="llm_max_tokens"
              type="number"
              min={1}
              value={form.llm_max_tokens}
              onChange={(e) => {
                const next = e.target.valueAsNumber;
                if (!Number.isNaN(next)) setForm((f) => ({ ...f, llm_max_tokens: next }));
              }}
            />
          </div>
        </div>
        <div className="mt-3">
          <VoicePicker value={form.voice_id} onChange={(voiceId) => setForm((f) => ({ ...f, voice_id: voiceId }))} />
        </div>
      </Card>

      {canManage && (
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={saving} onClick={handleSaveDraft}>
            {saving ? 'Saving...' : draft ? 'Save draft' : 'Create draft'}
          </Button>
          {!confirmPublish ? (
            <Button disabled={saving} onClick={() => setConfirmPublish(true)}>
              Publish
            </Button>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-gold-300 bg-gold-50 px-3 py-2 text-sm">
              <span>Publish this version? It becomes live for calls immediately.</span>
              <Button disabled={saving} onClick={handlePublish}>
                {saving ? 'Publishing...' : 'Confirm publish'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmPublish(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
