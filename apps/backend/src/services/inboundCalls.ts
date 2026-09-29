/**
 * Inbound calls, per explicit request: "if someone calls back it should
 * respond to that call and take details like name, phone, email, purpose
 * (depends upon which campaign it was about) ... from whichever number the
 * call was made it should be received to same, if not then by another
 * number".
 *
 * Every imported number is pointed at this backend (configureInboundNumbers
 * below): Vapi sends an `assistant-request` webhook when a call comes in,
 * and handleAssistantRequest answers with a complete assistant for that
 * specific caller:
 *
 * - Who's calling: the caller's number is matched to a lead in the
 *   organization. The campaign is the one that last called them; otherwise
 *   the campaign assigned to / dialing from the number they called.
 * - That campaign's own agent, voice, script, knowledge base and transfer
 *   number answer the call, with a greeting that recognises a returning
 *   caller by name ("thanks for calling back").
 * - The AI collects/confirms name, phone, email and purpose and saves them
 *   (save_caller_details creates the lead for an unknown caller), can
 *   schedule a callback, transfer, or add them to Do Not Call.
 * - If no agent can answer (or the webhook fails), Vapi sends the call to
 *   the number's fallback destination - the campaign's transfer number -
 *   so it still reaches a person instead of being dropped.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import { renderTemplate, spokenVoiceName, type PromptVariableContext } from '../lib/promptVariables.js';
import {
  buildScriptSection,
  buildTimeAndCallbackSection,
  composeSystemPrompt,
  CONVERSATION_GUIDANCE,
  KNOWLEDGE_BASE_INSTRUCTION,
  personalityLines,
} from '../lib/callGuidance.js';
import {
  buildAssistantConfig,
  getOrgVapiProvider,
  organizationTimezone,
  resolveActualVoice,
  resolveCallScriptAndKnowledge,
  spokenCampaignName,
} from './callOrigination.js';
import { loadCampaignCallContext } from './campaignCallContext.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const CONFIGURE_INTERVAL_MS = 30 * 60_000;

/** Campaign whose calls this number makes: explicitly assigned first, then
 * a running campaign dialing from it, then any campaign dialing from it. */
export async function campaignForNumber(supabase: Supabase, phoneNumber: Record<string, any>): Promise<Record<string, any> | null> {
  if (phoneNumber.assigned_campaign_id) {
    const { data } = await supabase.from('campaigns').select('*').eq('id', phoneNumber.assigned_campaign_id).eq('organization_id', phoneNumber.organization_id).maybeSingle();
    if (data) return data;
  }
  const { data: pool } = await supabase.from('campaign_phone_numbers').select('campaign_id').eq('phone_number_id', phoneNumber.id);
  const ids = (pool ?? []).map((r: { campaign_id: string }) => r.campaign_id);
  if (ids.length === 0) return null;
  const { data: campaigns } = await supabase.from('campaigns').select('*').in('id', ids).eq('organization_id', phoneNumber.organization_id).order('updated_at', { ascending: false });
  const list = campaigns ?? [];
  return list.find((c: any) => c.status === 'running') ?? list[0] ?? null;
}

/** Most recently published agent version: the number's assigned agent's,
 * else the organization's newest. */
async function fallbackAgentVersion(supabase: Supabase, phoneNumber: Record<string, any>): Promise<Record<string, any> | null> {
  let query = supabase
    .from('ai_agent_versions')
    .select('*')
    .eq('organization_id', phoneNumber.organization_id)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(1);
  if (phoneNumber.assigned_agent_id) query = query.eq('agent_id', phoneNumber.assigned_agent_id);
  const { data } = await query;
  return (data ?? [])[0] ?? null;
}

function describeWhen(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return null;
  }
}

export interface InboundContext {
  phoneNumber: Record<string, any>;
  callerE164: string | null;
  lead: Record<string, any> | null;
  campaign: Record<string, any> | null;
  lastCall: Record<string, any> | null;
}

export async function resolveInboundContext(supabase: Supabase, vapiPhoneNumberId: string | null, callerNumber: string | null): Promise<InboundContext | null> {
  if (!vapiPhoneNumberId) return null;
  const { data: phoneNumber } = await supabase.from('phone_numbers').select('*').eq('vapi_phone_number_id', vapiPhoneNumberId).maybeSingle();
  if (!phoneNumber) return null;
  const orgId = phoneNumber.organization_id as string;

  const normalized = callerNumber ? normalizePhoneNumber(callerNumber) : null;
  const callerE164 = normalized?.valid ? normalized.e164 : callerNumber;

  let lead: Record<string, any> | null = null;
  if (callerE164) {
    const { data } = await supabase.from('leads').select('*').eq('organization_id', orgId).eq('phone_normalized', callerE164).order('updated_at', { ascending: false }).limit(1);
    lead = (data ?? [])[0] ?? null;
  }

  // The campaign this caller is calling about: the one that last called them.
  let lastCall: Record<string, any> | null = null;
  if (lead) {
    const { data } = await supabase.from('calls').select('*').eq('organization_id', orgId).eq('lead_id', lead.id).order('created_at', { ascending: false }).limit(5);
    lastCall = (data ?? []).find((c: any) => c.campaign_id) ?? (data ?? [])[0] ?? null;
  } else if (callerE164) {
    const { data } = await supabase.from('calls').select('*').eq('organization_id', orgId).eq('customer_number', callerE164).order('created_at', { ascending: false }).limit(1);
    lastCall = (data ?? [])[0] ?? null;
  }

  let campaign: Record<string, any> | null = null;
  if (lastCall?.campaign_id) {
    const { data } = await supabase.from('campaigns').select('*').eq('id', lastCall.campaign_id).maybeSingle();
    campaign = data;
  }
  if (!campaign) campaign = await campaignForNumber(supabase, phoneNumber);

  return { phoneNumber, callerE164, lead, campaign, lastCall };
}

function inboundSection(ctx: InboundContext, campaignLabel: string | null, lastSummary: string | null, timeZone: string): string {
  const lines: string[] = ['INBOUND CALL: this person called us. You are answering the phone - not placing a call.'];
  if (ctx.lead) {
    const name = [ctx.lead.first_name, ctx.lead.last_name].filter(Boolean).join(' ').trim();
    const when = describeWhen(ctx.lastCall?.created_at, timeZone);
    lines.push(
      `Caller: ${name || 'name not on file'}, calling from ${ctx.callerE164 ?? 'an unknown number'}${ctx.lead.email ? `, email ${ctx.lead.email}` : ''}.`,
      ctx.lastCall
        ? `We called them ${when ? `on ${when}` : 'recently'}${campaignLabel ? ` about ${campaignLabel}` : ''} - treat this as them returning that call. Thank them for calling back.`
        : 'They are already in our records.',
    );
    if (lastSummary) lines.push(`Summary of the last call: ${lastSummary}`);
  } else {
    lines.push(`We don't have this caller on file yet (calling from ${ctx.callerE164 ?? 'an unknown number'}).`);
  }
  lines.push(
    "Early in the call, find out (or confirm) the caller's name, the best phone number to reach them, their email, and why they're calling. Ask naturally, one thing at a time, and skip anything you already know. Save what you learn with save_caller_details as soon as you have it (call it again when you learn more).",
    `Then help them: answer their questions and, if it fits, take them through the ${campaignLabel ? `${campaignLabel} ` : ''}conversation below. The script was written for outbound calls - skip its opening and introduction, and don't ask things they've already told you.`,
  );
  return lines.join('\n');
}

/** Builds Vapi's assistant-request response for one inbound call, and
 * records the call. Never throws - failures return { error }, which makes
 * Vapi use the number's fallback destination. */
export async function handleAssistantRequest(supabase: Supabase, message: Record<string, any>): Promise<Record<string, unknown>> {
  try {
    const vapiCall = message.call ?? {};
    const vapiPhoneNumberId: string | null = message.phoneNumber?.id ?? vapiCall.phoneNumberId ?? null;
    const callerNumber: string | null = message.customer?.number ?? vapiCall.customer?.number ?? null;

    const ctx = await resolveInboundContext(supabase, vapiPhoneNumberId, callerNumber);
    if (!ctx) return { error: 'This number is not set up to take calls.' };
    const orgId = ctx.phoneNumber.organization_id as string;

    const provider = await getOrgVapiProvider(supabase, orgId);
    if (!provider) return { error: 'Vapi is not connected for this organization.' };

    const campaignContext = ctx.campaign ? await loadCampaignCallContext(supabase, ctx.campaign) : null;
    const agentVersion = campaignContext?.agentVersionRow ?? (await fallbackAgentVersion(supabase, ctx.phoneNumber));
    if (!agentVersion) return { error: 'No published AI agent is available to answer this call.' };
    const agentId = (campaignContext?.version.ai_agent_id ?? agentVersion.agent_id) as string;
    const campaign = campaignContext ? ctx.campaign : null;

    const [actualVoice, orgRow, timezoneFromOrg] = await Promise.all([
      resolveActualVoice(supabase, orgId, agentVersion, campaignContext?.voiceOverride ?? null),
      supabase.from('organizations').select('name').eq('id', orgId).maybeSingle(),
      organizationTimezone(supabase, orgId),
    ]);
    const timeZone = campaignContext?.callingRules?.timezone ?? timezoneFromOrg ?? 'America/New_York';
    const voiceName = spokenVoiceName(actualVoice.name) ?? 'your assistant';
    const campaignLabel = campaign ? spokenCampaignName(campaign.name) : null;
    const company = campaignLabel ?? ((orgRow.data?.name as string | undefined)?.trim() || null);

    const promptContext: PromptVariableContext = {
      first_name: ctx.lead?.first_name || undefined,
      last_name: ctx.lead?.last_name || undefined,
      phone: ctx.callerE164 ?? undefined,
      email: ctx.lead?.email || undefined,
      agent_name: voiceName,
      custom_field: (ctx.lead?.custom_fields as Record<string, string> | undefined) ?? undefined,
    };

    let lastSummary: string | null = null;
    if (ctx.lastCall) {
      const { data } = await supabase.from('call_summaries').select('summary').eq('call_id', ctx.lastCall.id).maybeSingle();
      lastSummary = (data?.summary as string | undefined)?.slice(0, 600) ?? null;
    }

    const scriptAndKnowledge = await resolveCallScriptAndKnowledge(
      supabase,
      orgId,
      agentId,
      campaignContext ? campaignContext.scriptId : undefined,
      campaignContext ? campaignContext.knowledgeBaseIds : undefined,
    );

    const systemPrompt = composeSystemPrompt([
      renderTemplate(agentVersion.system_prompt ?? '', promptContext),
      ...personalityLines(agentVersion.personality),
      inboundSection(ctx, campaignLabel, lastSummary, timeZone),
      buildScriptSection(scriptAndKnowledge.scriptContent, promptContext),
      scriptAndKnowledge.hasKnowledgeBase ? KNOWLEDGE_BASE_INSTRUCTION : null,
      buildTimeAndCallbackSection(timeZone),
      CONVERSATION_GUIDANCE,
    ]);

    const firstName = (ctx.lead?.first_name as string | undefined)?.trim();
    const firstMessage = firstName
      ? `Hi ${firstName}, thanks for calling ${ctx.lastCall ? 'back' : company ? company : 'us'}! This is ${voiceName}${ctx.lastCall && company ? ` from ${company}` : ''}. How can I help you today?`
      : `Hi, thanks for calling${company ? ` ${company}` : ''}! This is ${voiceName}. May I ask who I'm speaking with?`;

    const transferDestination = campaignContext?.transferDestination ?? (agentVersion.transfer_rules?.transfer_to as string | null | undefined) ?? null;
    const config = await buildAssistantConfig(supabase, orgId, { id: agentId }, agentVersion, campaignContext?.voiceOverride ?? null, null);
    const assistant = provider.buildInboundAssistant(config, {
      firstMessage,
      systemPrompt,
      transferDestinationE164: transferDestination,
      knowledgeBaseSearch: scriptAndKnowledge.hasKnowledgeBase,
    });

    // Record the call so webhooks, Live Monitor, CDR and recordings pick it
    // up exactly like an outbound call (idempotent on Vapi's call id).
    const vapiCallId: string | null = vapiCall.id ?? null;
    if (vapiCallId) {
      const { data: existing } = await supabase.from('calls').select('id').eq('vapi_call_id', vapiCallId).maybeSingle();
      if (!existing) {
        const nowIso = new Date().toISOString();
        const { data: inserted, error } = await supabase
          .from('calls')
          .insert({
            organization_id: orgId,
            engine: 'vapi',
            vapi_call_id: vapiCallId,
            ai_agent_id: agentId,
            ai_agent_version_id: agentVersion.id,
            campaign_id: campaign?.id ?? null,
            lead_id: ctx.lead?.id ?? null,
            phone_number_id: ctx.phoneNumber.id,
            voice_id: actualVoice.id,
            direction: 'inbound',
            customer_number: ctx.callerE164 ?? callerNumber ?? 'unknown',
            status: 'answered',
            started_at: nowIso,
            answered_at: nowIso,
            transfer_destination_e164: transferDestination && /^\+[1-9]\d{6,14}$/.test(transferDestination) ? transferDestination : null,
          })
          .select('id')
          .single();
        if (error) throw error;
        await supabase.from('call_events').insert({
          call_id: inserted.id,
          organization_id: orgId,
          event_type: 'call.inbound_answered',
          payload: { engine: 'vapi', provider_call_id: vapiCallId, campaign_id: campaign?.id ?? null, known_caller: Boolean(ctx.lead) },
        });
      }
    }

    return { assistant };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('inbound assistant-request failed', err);
    return { error: 'Could not start the assistant for this call.' };
  }
}

/** Points every imported number at this backend for inbound calls, with
 * the number's campaign transfer number as the fallback destination. */
export async function configureInboundNumbers(orgId: string | null = null): Promise<{ configured: number; failed: number }> {
  const supabase = getSupabaseAdmin();
  let query = supabase.from('phone_numbers').select('*').eq('status', 'active');
  if (orgId) query = query.eq('organization_id', orgId);
  const { data: numbers } = await query;
  let configured = 0;
  let failed = 0;
  const providers = new Map<string, Awaited<ReturnType<typeof getOrgVapiProvider>>>();
  for (const pn of numbers ?? []) {
    if (!pn.vapi_phone_number_id) continue;
    try {
      if (!providers.has(pn.organization_id)) providers.set(pn.organization_id, await getOrgVapiProvider(supabase, pn.organization_id));
      const provider = providers.get(pn.organization_id);
      if (!provider) continue;
      const campaign = await campaignForNumber(supabase, pn);
      const context = campaign ? await loadCampaignCallContext(supabase, campaign) : null;
      await provider.configureInboundNumber(pn.vapi_phone_number_id, context?.transferDestination ?? null);
      configured += 1;
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error('configureInboundNumbers: failed for number', pn.id, err instanceof Error ? err.message : err);
    }
  }
  return { configured, failed };
}

let handle: ReturnType<typeof setInterval> | null = null;

export function startInboundNumberSync(): void {
  if (handle) return;
  const run = () =>
    configureInboundNumbers()
      .then((r) => {
        // eslint-disable-next-line no-console
        if (r.configured || r.failed) console.log('inbound numbers configured', r);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('inbound number sync failed', err);
      });
  void run();
  handle = setInterval(run, CONFIGURE_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
}
