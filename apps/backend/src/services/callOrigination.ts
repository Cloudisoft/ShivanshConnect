/**
 * Phase 6/7: the one real call-origination engine.
 *
 * This is the exact origination logic Phase 6's `POST /calls` route
 * handler used to inline. Phase 7's campaign dispatcher
 * (services/campaignDispatcher.ts) needs to originate calls the same way
 * the manual "place a call" flow does - the task brief is explicit that
 * the dispatcher must call into the SAME logic, not re-implement it - so
 * it is extracted here as a plain function both call sites invoke.
 * routes/calls.ts's POST handler is now a thin wrapper: it resolves/
 * authorizes the agent, lead, phone number and (for a manual call)
 * defaults the engine, then calls `originateCall()`. The dispatcher does
 * its own resolution (from the campaign's published snapshot, not
 * `ai_agents.current_version_id`) and calls the exact same function.
 *
 * Failure-recovery ordering (spec section 72) is unchanged from Phase 6:
 * the local `calls` row is inserted in 'queued' status BEFORE the
 * provider's createCall() is ever invoked.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ValidationError } from '../lib/errors.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, type CallEngine, type BackgroundNoise, DEFAULT_CALL_ENGINE_SETTINGS_KEY } from '@shivanshconnect/shared';
import { createOrchestrationProvider, OrchestrationProviderError, OrchestrationProviderNotConfiguredError, type AssistantConfig } from '../lib/orchestration/index.js';
import { transitionCallState } from '../lib/callStateMachine.js';
import { VapiProvider } from '../lib/orchestration/vapi.js';
import { decryptCredentials, type EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { toAdapterCredentials as toTelephonyAdapterCredentials } from '../routes/phoneNumberProviders.js';
import { renderTemplate, type PromptVariableContext } from '../lib/promptVariables.js';

/**
 * Appended to the resolved system prompt only for the unnamed/no-lead
 * fallback path (see resolveCallPersonalization()) - the named path
 * already has the lead's real name baked into the rendered greeting, so
 * there is nothing to "ask for". This is the concrete instruction the
 * spec calls for: once the caller volunteers their name in response to
 * the generic greeting, the assistant should pick it up and use it
 * naturally for the rest of the call instead of ignoring it.
 */
const ASK_CALLER_NAME_INSTRUCTION =
  "\n\nYou do not yet know this caller's name. Early in the conversation, politely ask for their name if they haven't already given it, and once they do, use their first name naturally for the rest of the call.";

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export async function resolveDefaultEngine(supabase: Supabase, orgId: string): Promise<CallEngine> {
  const { data } = await supabase.from('organization_settings').select('settings').eq('organization_id', orgId).maybeSingle();
  const configured = (data?.settings as Record<string, unknown> | undefined)?.[DEFAULT_CALL_ENGINE_SETTINGS_KEY];
  return configured === 'pipecat' ? 'pipecat' : 'vapi';
}

/** Returns this org's connected VapiProvider, or null if Vapi has no
 * credentials stored for it - never throws, so callers doing a
 * best-effort/eager sync (phone number purchase, agent publish) can skip
 * cleanly instead of failing the primary action. */
export async function getOrgVapiProvider(supabase: Supabase, orgId: string): Promise<VapiProvider | null> {
  const { data: credRow } = await supabase.from('vapi_credentials').select('encrypted_credentials').eq('organization_id', orgId).maybeSingle();
  if (!credRow) return null;
  const apiKey = decryptCredentials<{ api_key: string }>(credRow.encrypted_credentials as EncryptedEnvelope).api_key;
  return createOrchestrationProvider('vapi', { api_key: apiKey }) as VapiProvider;
}

export async function buildAssistantConfig(
  supabase: Supabase,
  orgId: string,
  agent: { id: string },
  version: Record<string, any>,
  voiceOverride: { providerKey: string; providerVoiceId: string } | null,
  callingRulesOverride?: {
    voicemail_detection_enabled: boolean;
    voicemail_message: string | null;
    leave_voicemail: boolean;
    background_noise: BackgroundNoise | null;
  } | null,
): Promise<AssistantConfig> {
  let voice: AssistantConfig['voice'] = voiceOverride;
  if (!voice && version.voice_id) {
    const { data: voiceRow } = await supabase.from('voices').select('provider_key, provider_voice_id').eq('id', version.voice_id).maybeSingle();
    if (voiceRow) voice = { providerKey: voiceRow.provider_key, providerVoiceId: voiceRow.provider_voice_id };
  }
  return {
    agentId: agent.id,
    agentVersionId: version.id,
    organizationId: orgId,
    name: `Agent ${agent.id}`,
    systemPrompt: version.system_prompt,
    greeting: version.greeting_template,
    personality: version.personality ?? { tone: null, personality_traits: [], behavior_traits: [] },
    llmProvider: version.llm_provider,
    llmModel: version.llm_model,
    llmTemperature: version.llm_temperature,
    llmMaxTokens: version.llm_max_tokens,
    voice,
    transferRules: version.transfer_rules ?? { on_no_match: 'end_call', transfer_to: null, conditions: [] },
    maxCallDurationSeconds: version.call_ending_rules?.max_call_duration_seconds ?? null,
    // Bug fix: Phase 7's campaign calling-rules columns previously never
    // reached the Vapi assistant payload at all - see
    // lib/orchestration/vapi.ts's toVapiAssistantPayload() for exactly
    // how these are mapped to Vapi's real voicemailDetection/
    // backgroundDenoisingEnabled fields.
    voicemailDetection: callingRulesOverride
      ? {
          enabled: callingRulesOverride.voicemail_detection_enabled,
          leaveVoicemail: callingRulesOverride.leave_voicemail,
          message: callingRulesOverride.voicemail_message,
        }
      : null,
    backgroundNoise: callingRulesOverride?.background_noise ?? null,
  };
}

/**
 * Resolves the ACTUAL, ready-to-send greeting and system prompt for one
 * specific call - the fix for the core Bug 1 gap: `buildAssistantConfig()`
 * only ever configures the cached, reused assistant object, so per-lead
 * `{{variables}}` can never work by baking them into it. This function
 * instead renders the real per-call strings that get passed down as
 * `firstMessageOverride`/`systemPromptOverride` on `provider.createCall()`
 * (Vapi: `assistantOverrides` on POST /call - see vapi.ts;
 * pipecat: extra per-call payload fields - see pipecat.ts), so a
 * personalized greeting/system prompt applies to THIS call only, never
 * mutating the shared assistant record other leads will also be dialed
 * through.
 */
async function resolveCallPersonalization(
  supabase: Supabase,
  orgId: string,
  agent: { id: string },
  version: Record<string, any>,
  leadId: string | null,
  campaignId: string | null,
  voiceOverride: { providerKey: string; providerVoiceId: string } | null,
): Promise<{ firstMessage: string; systemPrompt: string }> {
  let lead: Record<string, any> | null = null;
  if (leadId) {
    const { data } = await supabase
      .from('leads')
      .select('first_name, last_name, phone_normalized, email, custom_fields')
      .eq('id', leadId)
      .eq('organization_id', orgId)
      .maybeSingle();
    lead = data ?? null;
  }

  const context: PromptVariableContext = {
    first_name: lead?.first_name || undefined,
    last_name: lead?.last_name || undefined,
    phone: lead?.phone_normalized || undefined,
    email: lead?.email || undefined,
    custom_field: (lead?.custom_fields as Record<string, string> | undefined) ?? undefined,
  };

  const hasName = Boolean(context.first_name && context.first_name.trim().length > 0);
  const renderedSystemPrompt = renderTemplate(version.system_prompt ?? '', context);

  if (hasName) {
    // Named lead: use the campaign/agent author's own greeting template,
    // rendered live against this lead's real data (e.g. "Hi, am I
    // speaking with {{first_name}}?").
    const firstMessage = renderTemplate(version.greeting_template ?? '', context);
    return { firstMessage, systemPrompt: renderedSystemPrompt };
  }

  // Unnamed lead, or no lead at all (a manual test call): never render
  // the named greeting template against an empty {{first_name}} (that
  // would either leave the literal "{{first_name}}" in the caller's ear,
  // per renderTemplate()'s own documented "never silently blank" rule,
  // or produce an awkward "Hi, am I speaking with ?"). Build a real,
  // generic, product-specified fallback instead: "Hi, my name is
  // {voice} from {campaign/agent}. How are you doing today?"
  let voiceName = 'your assistant';
  if (voiceOverride) {
    const { data } = await supabase
      .from('voices')
      .select('name')
      .eq('organization_id', orgId)
      .eq('provider_key', voiceOverride.providerKey)
      .eq('provider_voice_id', voiceOverride.providerVoiceId)
      .maybeSingle();
    if (data?.name) voiceName = data.name;
  } else if (version.voice_id) {
    const { data } = await supabase.from('voices').select('name').eq('id', version.voice_id).maybeSingle();
    if (data?.name) voiceName = data.name;
  }

  let orgOrCampaignName: string | null = null;
  if (campaignId) {
    const { data } = await supabase.from('campaigns').select('name').eq('id', campaignId).eq('organization_id', orgId).maybeSingle();
    orgOrCampaignName = data?.name ?? null;
  }
  if (!orgOrCampaignName) {
    const { data } = await supabase.from('ai_agents').select('name').eq('id', agent.id).eq('organization_id', orgId).maybeSingle();
    orgOrCampaignName = data?.name ?? null;
  }

  const firstMessage = `Hi, my name is ${voiceName} from ${orgOrCampaignName ?? 'our team'}. How are you doing today?`;
  return { firstMessage, systemPrompt: `${renderedSystemPrompt}${ASK_CALLER_NAME_INSTRUCTION}` };
}

/** Resolves the transfer destination for this call: an explicit
 * `transferDestinationOverride` (a campaign version's own snapshotted,
 * pre-validated E.164 number - spec 84) wins when present; otherwise
 * falls back to the agent version's own configured transfer_rules.
 * transfer_to (Phase 6's original behavior for a non-campaign manual
 * call). Never anything client/AI-supplied - spec 19/8L. */
export function resolveTransferDestination(version: Record<string, any>, transferDestinationOverride?: string | null): string | null {
  const configured = transferDestinationOverride ?? (version.transfer_rules?.transfer_to as string | null | undefined) ?? null;
  if (!configured) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(configured)) {
    throw new ValidationError('This call has an invalid transfer destination configured - fix it before placing calls.');
  }
  return configured;
}

/** Ensures the given phone number has a Vapi-side phone-number id,
 * importing it the first time it's used. */
export async function ensureVapiPhoneNumberImported(
  supabase: Supabase,
  orgId: string,
  phoneNumber: Record<string, any>,
  vapiProvider: VapiProvider,
): Promise<string> {
  if (phoneNumber.vapi_phone_number_id) return phoneNumber.vapi_phone_number_id as string;

  if (phoneNumber.provider_key === 'twilio' || phoneNumber.provider_key === 'telnyx') {
    const { data: credRow } = await supabase
      .from('phone_number_provider_credentials')
      .select('encrypted_credentials')
      .eq('organization_id', orgId)
      .eq('provider_key', phoneNumber.provider_key)
      .maybeSingle();
    if (!credRow) {
      throw new ValidationError(`${phoneNumber.provider_key} is not connected for this organization - cannot import this number into Vapi.`);
    }
    const creds = toTelephonyAdapterCredentials(phoneNumber.provider_key, credRow.encrypted_credentials as EncryptedEnvelope);
    const imported =
      phoneNumber.provider_key === 'twilio'
        ? await vapiProvider.importPhoneNumber({
            provider: 'twilio',
            e164: phoneNumber.phone_number,
            twilioAccountSid: (creds as { account_sid: string }).account_sid,
            twilioAuthToken: (creds as { auth_token: string }).auth_token,
          })
        : await vapiProvider.importPhoneNumber({ provider: 'telnyx', e164: phoneNumber.phone_number, telnyxApiKey: (creds as { api_key: string }).api_key });

    await supabase.from('phone_numbers').update({ vapi_phone_number_id: imported.vapiPhoneNumberId }).eq('id', phoneNumber.id);
    return imported.vapiPhoneNumberId;
  }

  if (!phoneNumber.sip_trunk_metadata?.host) {
    throw new ValidationError('This BYON number has no SIP trunk configured - cannot import it into Vapi for outbound calling.');
  }
  const imported = await vapiProvider.importPhoneNumber({ provider: 'byo-sip-trunk', e164: phoneNumber.phone_number, sipTrunkGatewayHost: phoneNumber.sip_trunk_metadata.host });
  await supabase.from('phone_numbers').update({ vapi_phone_number_id: imported.vapiPhoneNumberId }).eq('id', phoneNumber.id);
  return imported.vapiPhoneNumberId;
}

export interface OriginateCallParams {
  organizationId: string;
  engine: CallEngine;
  agent: { id: string };
  version: Record<string, any>;
  phoneNumber: Record<string, any>;
  customerNumber: string;
  leadId: string | null;
  campaignId: string | null;
  createdBy: string | null;
  /** Campaign snapshot override - see resolveTransferDestination(). */
  transferDestinationOverride?: string | null;
  voiceOverride?: { providerKey: string; providerVoiceId: string } | null;
  /** Campaign snapshot's calling-rules (voicemail/background-noise) -
   * see buildAssistantConfig()'s voicemailDetection/backgroundNoise
   * fields. Null/undefined for a manual, non-campaign call. */
  callingRulesOverride?: {
    voicemail_detection_enabled: boolean;
    voicemail_message: string | null;
    leave_voicemail: boolean;
    background_noise: BackgroundNoise | null;
  } | null;
}

export interface OriginateCallResult {
  call: Record<string, any>;
}

/** Places one real outbound call through the resolved engine, exactly the
 * way Phase 6's POST /calls always has. Used directly by that route AND
 * by the Phase 7 campaign dispatcher - never duplicated. */
export async function originateCall(params: OriginateCallParams): Promise<OriginateCallResult> {
  const supabase = getSupabaseAdmin();
  const { organizationId: orgId, engine, agent, version, phoneNumber, customerNumber, leadId, campaignId, createdBy } = params;

  const transferDestination = resolveTransferDestination(version, params.transferDestinationOverride);
  const { firstMessage: firstMessageOverride, systemPrompt: systemPromptOverride } = await resolveCallPersonalization(
    supabase,
    orgId,
    agent,
    version,
    leadId,
    campaignId,
    params.voiceOverride ?? null,
  );

  const { data: call, error: insertError } = await supabase
    .from('calls')
    .insert({
      organization_id: orgId,
      engine,
      ai_agent_id: agent.id,
      ai_agent_version_id: version.id,
      campaign_id: campaignId,
      lead_id: leadId,
      phone_number_id: phoneNumber.id,
      direction: 'outbound',
      customer_number: customerNumber,
      status: 'queued',
      transfer_destination_e164: transferDestination,
      created_by: createdBy,
    })
    .select('*')
    .single();
  if (insertError) throw insertError;

  try {
    if (engine === 'vapi') {
      const provider = await getOrgVapiProvider(supabase, orgId);
      if (!provider) throw new OrchestrationProviderNotConfiguredError('Vapi is not connected for this organization. Add an API key under Settings > Integrations first.');

      let assistantId = version.vapi_assistant_id as string | null;
      if (!assistantId || params.voiceOverride || campaignId) {
        // A campaign-level voice override OR any campaign call at all
        // means the published agent version's own Vapi assistant (built
        // with ITS voice and no calling-rules config) is not necessarily
        // what this campaign snapshot wants - build a fresh assistant for
        // this call rather than silently using the wrong voice, or
        // silently dropping the campaign's voicemail-detection/
        // background-noise settings on the floor. A plain manual call (no
        // campaign, no override) reuses/creates the version's own
        // assistant exactly like Phase 6 always did.
        const assistantConfig = await buildAssistantConfig(supabase, orgId, agent, version, params.voiceOverride ?? null, params.callingRulesOverride ?? null);
        const created = await provider.createAssistant(assistantConfig);
        assistantId = created.providerAssistantId;
        if (!params.voiceOverride && !campaignId) {
          await supabase.from('ai_agent_versions').update({ vapi_assistant_id: assistantId }).eq('id', version.id);
        }
      }

      const vapiPhoneNumberId = await ensureVapiPhoneNumberImported(supabase, orgId, phoneNumber, provider);

      const created = await provider.createCall({
        callId: call.id,
        organizationId: orgId,
        providerAssistantId: assistantId,
        agentVersionId: version.id,
        fromPhoneNumber: phoneNumber.phone_number,
        fromPhoneNumberProviderId: vapiPhoneNumberId,
        toPhoneNumber: customerNumber,
        transferDestinationE164: transferDestination,
        firstMessageOverride,
        systemPromptOverride,
      });

      await supabase.from('calls').update({ vapi_call_id: created.providerCallId, started_at: new Date().toISOString() }).eq('id', call.id);
      const transition = await transitionCallState(supabase, call.id, 'dialing');
      const updated = transition.call ?? call;

      await supabase.from('call_events').insert({
        call_id: call.id,
        organization_id: orgId,
        event_type: 'call.originated',
        payload: { engine: 'vapi', provider_call_id: created.providerCallId, campaign_id: campaignId },
      });

      await writeAuditLog({ organizationId: orgId, userId: createdBy, action: AUDIT_ACTIONS.CALL_CREATED, entityType: 'call', entityId: call.id, newValue: { engine, vapi_call_id: created.providerCallId, campaign_id: campaignId } });

      return { call: updated };
    }

    if (phoneNumber.provider_key !== 'twilio' && phoneNumber.provider_key !== 'telnyx') {
      throw new ValidationError('The pipecat engine currently places calls through a connected Twilio or Telnyx number only - this number is BYON.');
    }
    const { data: telephonyCredRow } = await supabase
      .from('phone_number_provider_credentials')
      .select('encrypted_credentials')
      .eq('organization_id', orgId)
      .eq('provider_key', phoneNumber.provider_key)
      .maybeSingle();
    if (!telephonyCredRow) {
      throw new ValidationError(`${phoneNumber.provider_key} is not connected for this organization - required for the pipecat engine to place this call.`);
    }
    const telephonyCreds = toTelephonyAdapterCredentials(phoneNumber.provider_key, telephonyCredRow.encrypted_credentials as EncryptedEnvelope);

    const provider = createOrchestrationProvider('pipecat');
    const created = await provider.createCall({
      callId: call.id,
      organizationId: orgId,
      providerAssistantId: null,
      agentVersionId: version.id,
      fromPhoneNumber: phoneNumber.phone_number,
      fromPhoneNumberProviderId: null,
      toPhoneNumber: customerNumber,
      transferDestinationE164: transferDestination,
      telephonyCredentials:
        phoneNumber.provider_key === 'twilio'
          ? { provider: 'twilio', accountSid: (telephonyCreds as { account_sid: string }).account_sid, authToken: (telephonyCreds as { auth_token: string }).auth_token }
          : { provider: 'telnyx', apiKey: (telephonyCreds as { api_key: string }).api_key },
      firstMessageOverride,
      systemPromptOverride,
    });

    await supabase.from('calls').update({ pipecat_call_id: created.providerCallId, started_at: new Date().toISOString() }).eq('id', call.id);
    const pipecatTransition = await transitionCallState(supabase, call.id, 'dialing');
    const updated = pipecatTransition.call ?? call;

    await supabase.from('call_events').insert({
      call_id: call.id,
      organization_id: orgId,
      event_type: 'call.originated',
      payload: { engine: 'pipecat', provider_call_id: created.providerCallId, campaign_id: campaignId },
    });

    await writeAuditLog({ organizationId: orgId, userId: createdBy, action: AUDIT_ACTIONS.CALL_CREATED, entityType: 'call', entityId: call.id, newValue: { engine, pipecat_call_id: created.providerCallId, campaign_id: campaignId } });

    return { call: updated };
  } catch (err) {
    // Deliberately NOT routed through transitionCallState()/the terminal
    // handler here: this is a pre-flight origination failure (e.g. a
    // misconfigured provider) that happens before campaign_leads.
    // last_call_id is ever set to this call's id (that only happens on a
    // SUCCESSFUL originateCall(), see campaignDispatcher.ts) - the
    // terminal handler's "only update the row this exact call is the most
    // current attempt for" guard would otherwise silently skip the
    // campaign_leads bookkeeping entirely and leave it stuck in
    // 'dialing'. The dispatcher's own catch block handles that
    // bookkeeping directly for this specific failure path instead.
    const message = err instanceof Error ? err.message : 'Call origination failed.';
    await supabase.from('calls').update({ status: 'failed', ended_reason: message, ended_at: new Date().toISOString() }).eq('id', call.id);
    await supabase.from('call_events').insert({ call_id: call.id, organization_id: orgId, event_type: 'call.origination_failed', payload: { error: message } });
    if (err instanceof OrchestrationProviderNotConfiguredError || err instanceof OrchestrationProviderError) throw err;
    throw err;
  }
}
