import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createCallSchema, listCallsQuerySchema } from '../schemas/orchestration.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, DEFAULT_CALL_ENGINE_SETTINGS_KEY, type CallEngine } from '@shivanshconnect/shared';
import { isValidNormalizedPhone, normalizePhoneNumber } from '../lib/phone.js';
import { decryptCredentials, type EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { createOrchestrationProvider, OrchestrationProviderError, OrchestrationProviderNotConfiguredError, type AssistantConfig } from '../lib/orchestration/index.js';
import { VapiProvider } from '../lib/orchestration/vapi.js';
import { toAdapterCredentials as toTelephonyAdapterCredentials } from './phoneNumberProviders.js';

const CALL_COLUMNS =
  'id, organization_id, engine, vapi_call_id, pipecat_call_id, ai_agent_id, ai_agent_version_id, campaign_id, lead_id, phone_number_id, direction, customer_number, status, started_at, answered_at, ended_at, duration_seconds, talk_duration_seconds, ended_reason, transfer_destination_e164, transfer_status, cost, created_by, created_at, updated_at';

async function resolveDefaultEngine(supabase: ReturnType<typeof getSupabaseAdmin>, orgId: string): Promise<CallEngine> {
  const { data } = await supabase.from('organization_settings').select('settings').eq('organization_id', orgId).maybeSingle();
  const configured = (data?.settings as Record<string, unknown> | undefined)?.[DEFAULT_CALL_ENGINE_SETTINGS_KEY];
  return configured === 'pipecat' ? 'pipecat' : 'vapi';
}

async function buildAssistantConfig(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  agent: { id: string },
  version: Record<string, any>,
): Promise<AssistantConfig> {
  let voice: AssistantConfig['voice'] = null;
  if (version.voice_id) {
    const { data: voiceRow } = await supabase.from('voices').select('provider_key, provider_voice_id').eq('id', version.voice_id).maybeSingle();
    if (voiceRow) voice = { providerKey: voiceRow.provider_key, providerVoiceId: voiceRow.provider_voice_id };
  }
  return {
    agentId: agent.id,
    agentVersionId: version.id,
    organizationId: orgId,
    name: version.greeting_template ? `Agent ${agent.id}` : `Agent ${agent.id}`,
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
  };
}

/** Resolves this call's transfer destination purely from server-side
 * stored config (the agent version's own transfer_rules.transfer_to) -
 * never from anything the caller of POST /calls supplied. Hard rule from
 * spec 19/8L/58. Returns null when the agent has none configured, and
 * throws if a configured value somehow isn't valid E.164 (defensive - the
 * agent config UI is expected to only ever store a validated number). */
function resolveTransferDestination(version: Record<string, any>): string | null {
  const configured = version.transfer_rules?.transfer_to as string | null | undefined;
  if (!configured) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(configured)) {
    throw new ValidationError('This agent version has an invalid transfer destination configured - fix it before placing calls.');
  }
  return configured;
}

/** Ensures the given phone number has a Vapi-side phone-number id,
 * importing it (real Vapi POST /phone-number) the first time it's used.
 * Only ever imports a number that has real Twilio/Telnyx credentials
 * (or, for BYON, real SIP trunk metadata) already stored for it - never
 * fabricates an import. */
async function ensureVapiPhoneNumberImported(
  supabase: ReturnType<typeof getSupabaseAdmin>,
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

  // BYON
  if (!phoneNumber.sip_trunk_metadata?.host) {
    throw new ValidationError('This BYON number has no SIP trunk configured - cannot import it into Vapi for outbound calling.');
  }
  const imported = await vapiProvider.importPhoneNumber({ provider: 'byo-sip-trunk', e164: phoneNumber.phone_number, sipTrunkGatewayHost: phoneNumber.sip_trunk_metadata.host });
  await supabase.from('phone_numbers').update({ vapi_phone_number_id: imported.vapiPhoneNumberId }).eq('id', phoneNumber.id);
  return imported.vapiPhoneNumberId;
}

export async function callRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/calls
  app.get('/', { preHandler: requirePermission('calls.manage') }, async (req) => {
    const query = listCallsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('calls').select(CALL_COLUMNS, { count: 'exact' }).eq('organization_id', orgId);
    if (query.status) builder = builder.eq('status', query.status);
    if (query.engine) builder = builder.eq('engine', query.engine);
    if (query.ai_agent_id) builder = builder.eq('ai_agent_id', query.ai_agent_id);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // GET /api/v1/calls/:id
  app.get('/:id', { preHandler: requirePermission('calls.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: call, error } = await supabase.from('calls').select(CALL_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!call || call.organization_id !== orgId) throw new NotFoundError('Call not found.');

    const { data: events } = await supabase
      .from('call_events')
      .select('id, event_type, payload, occurred_at')
      .eq('call_id', id)
      .order('occurred_at', { ascending: true });

    return ok({ ...call, events: events ?? [] });
  });

  // POST /api/v1/calls - internal call-origination endpoint. Used
  // directly today, and by Phase 7's campaign dialing engine later.
  //
  // Failure-recovery ordering (spec section 72): the local `calls` row is
  // inserted in 'queued' status BEFORE the provider's createCall() is
  // ever invoked, and only then updated with the engine-specific external
  // id once the provider confirms. supabase-js talks to PostgREST, which
  // has no client-side multi-statement transaction API to wrap this in -
  // no route in this codebase uses one - so the guarantee here comes from
  // strict ordering instead: if the process crashes or the provider call
  // throws AFTER the local row exists, the row is marked 'failed' with the
  // real error (never silently orphaned); if it crashes BEFORE the local
  // row is inserted, no provider call has been placed yet either, so
  // there is nothing to orphan on the provider's side.
  app.post('/', { preHandler: requirePermission('calls.manage') }, async (req) => {
    const body = createCallSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: agent, error: agentError } = await supabase.from('ai_agents').select('id, organization_id, current_version_id').eq('id', body.agent_id).maybeSingle();
    if (agentError) throw agentError;
    if (!agent || agent.organization_id !== orgId) throw new NotFoundError('Agent not found.');
    if (!agent.current_version_id) throw new ValidationError('This agent has no published version yet - publish one before placing calls.');

    const { data: version, error: versionError } = await supabase.from('ai_agent_versions').select('*').eq('id', agent.current_version_id).maybeSingle();
    if (versionError) throw versionError;
    if (!version) throw new NotFoundError('Published agent version not found.');

    const { data: phoneNumber, error: phoneError } = await supabase.from('phone_numbers').select('*').eq('id', body.phone_number_id).maybeSingle();
    if (phoneError) throw phoneError;
    if (!phoneNumber || phoneNumber.organization_id !== orgId) throw new NotFoundError('Phone number not found.');
    if (phoneNumber.status !== 'active') throw new ValidationError('This phone number is not active.');

    let customerNumber: string;
    let leadId: string | null = null;
    if (body.lead_id) {
      const { data: lead, error: leadError } = await supabase.from('leads').select('id, organization_id, phone_normalized, is_dnc').eq('id', body.lead_id).maybeSingle();
      if (leadError) throw leadError;
      if (!lead || lead.organization_id !== orgId) throw new NotFoundError('Lead not found.');
      if (lead.is_dnc) throw new ValidationError('This lead is on the Do Not Call list - calls cannot be placed to it.');
      customerNumber = lead.phone_normalized;
      leadId = lead.id;
    } else if (body.customer_number) {
      const normalized = normalizePhoneNumber(body.customer_number);
      if (!isValidNormalizedPhone(normalized)) throw new ValidationError('customer_number is not a valid phone number.');
      customerNumber = normalized.e164;
    } else {
      throw new ValidationError('Either lead_id or customer_number is required.');
    }

    const engine = body.engine ?? (await resolveDefaultEngine(supabase, orgId));
    const transferDestination = resolveTransferDestination(version);

    // Local row created first, in 'queued' status - see the handler's
    // header comment for exactly why this ordering is the failure-
    // recovery guarantee here.
    const { data: call, error: insertError } = await supabase
      .from('calls')
      .insert({
        organization_id: orgId,
        engine,
        ai_agent_id: agent.id,
        ai_agent_version_id: version.id,
        lead_id: leadId,
        phone_number_id: phoneNumber.id,
        direction: 'outbound',
        customer_number: customerNumber,
        status: 'queued',
        transfer_destination_e164: transferDestination,
        created_by: req.user!.id,
      })
      .select(CALL_COLUMNS)
      .single();
    if (insertError) throw insertError;

    try {
      if (engine === 'vapi') {
        const { data: credRow } = await supabase.from('vapi_credentials').select('encrypted_credentials').eq('organization_id', orgId).maybeSingle();
        if (!credRow) throw new OrchestrationProviderNotConfiguredError('Vapi is not connected for this organization. Add an API key under Settings > Integrations first.');
        const apiKey = decryptCredentials<{ api_key: string }>(credRow.encrypted_credentials as EncryptedEnvelope).api_key;
        const provider = createOrchestrationProvider('vapi', { api_key: apiKey }) as VapiProvider;

        let assistantId = version.vapi_assistant_id as string | null;
        if (!assistantId) {
          const assistantConfig = await buildAssistantConfig(supabase, orgId, agent, version);
          const created = await provider.createAssistant(assistantConfig);
          assistantId = created.providerAssistantId;
          await supabase.from('ai_agent_versions').update({ vapi_assistant_id: assistantId }).eq('id', version.id);
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
        });

        const { data: updated, error: updateError } = await supabase
          .from('calls')
          .update({ vapi_call_id: created.providerCallId, status: 'dialing', started_at: new Date().toISOString() })
          .eq('id', call.id)
          .select(CALL_COLUMNS)
          .single();
        if (updateError) throw updateError;

        await supabase.from('call_events').insert({
          call_id: call.id,
          organization_id: orgId,
          event_type: 'call.originated',
          payload: { engine: 'vapi', provider_call_id: created.providerCallId },
        });

        await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CALL_CREATED, entityType: 'call', entityId: call.id, newValue: { engine, vapi_call_id: created.providerCallId } });

        return ok(updated, { message: 'Call placed.' });
      }

      // pipecat
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
      });

      const { data: updated, error: updateError } = await supabase
        .from('calls')
        .update({ pipecat_call_id: created.providerCallId, status: 'dialing', started_at: new Date().toISOString() })
        .eq('id', call.id)
        .select(CALL_COLUMNS)
        .single();
      if (updateError) throw updateError;

      await supabase.from('call_events').insert({
        call_id: call.id,
        organization_id: orgId,
        event_type: 'call.originated',
        payload: { engine: 'pipecat', provider_call_id: created.providerCallId },
      });

      await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CALL_CREATED, entityType: 'call', entityId: call.id, newValue: { engine, pipecat_call_id: created.providerCallId } });

      return ok(updated, { message: 'Call placed.' });
    } catch (err) {
      // The provider call failed (or the engine isn't configured) - the
      // local row already exists, so mark it failed rather than leaving
      // it stuck in 'queued' forever. Never retried silently/fabricated.
      const message = err instanceof Error ? err.message : 'Call origination failed.';
      await supabase.from('calls').update({ status: 'failed', ended_reason: message, ended_at: new Date().toISOString() }).eq('id', call.id);
      await supabase.from('call_events').insert({ call_id: call.id, organization_id: orgId, event_type: 'call.origination_failed', payload: { error: message } });
      if (err instanceof OrchestrationProviderNotConfiguredError || err instanceof OrchestrationProviderError) throw err;
      throw err;
    }
  });
}
