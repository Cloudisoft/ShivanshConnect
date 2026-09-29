/**
 * Places AI callbacks when they fall due, per explicit request: "if on the
 * call the caller says to call back later then AI should take date and
 * time and schedule the call backs automatically".
 *
 * Callbacks used to be dialed only indirectly: createCallback() moved the
 * lead's campaign_leads.next_eligible_at to the callback time, so the
 * campaign dialer picked it up - but only while that campaign was running,
 * and never for a callback with no campaign (an inbound caller). This
 * dialer places every due, AI-assigned callback itself:
 *
 * - Campaign callbacks use the campaign's current snapshot (agent, voice,
 *   number pool, transfer number, script, knowledge base) and respect its
 *   calling days/window. The lead's campaign_leads row is claimed first
 *   (same compare-and-set the campaign dialer uses), so the two dialers
 *   can never both call the same person.
 * - Callbacks without a campaign reuse the call they came from (its agent
 *   version, number and voice).
 * - DNC leads are never called; a lead already on a live call waits.
 *
 * Callback status: scheduled -> calling (claimed) -> completed (call
 * placed) / failed / cancelled (DNC). A callback the campaign dialer
 * fulfils is marked completed by markDueCallbacksCompleted()
 * (callbackScheduler.ts).
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { findDncMatches } from '../lib/leadHelpers.js';
import { originateCall, resolveDefaultEngine } from './callOrigination.js';
import { loadCampaignCallContext } from './campaignCallContext.js';
import { isWithinCallingDay, isWithinCallingWindow } from './leadEligibility.js';
import { ACTIVE_CALL_STATUSES } from './campaignDispatcher.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const TICK_INTERVAL_MS = Number.parseInt(process.env.CALLBACK_DISPATCH_INTERVAL_MS ?? '', 10) || 30_000;
const BATCH_SIZE = 10;
const IN_FLIGHT_LEAD_STATUSES = ['dialing', 'ringing', 'connected', 'in_progress', 'transferring'];
/** A callback this overdue is not dialed out of the blue - it is marked
 * missed for someone to reschedule (covers weekends/closed calling hours). */
const MAX_OVERDUE_MS = 72 * 60 * 60_000;

/** Sets the status and appends `note` to the callback's notes (never
 * replacing what the AI or a user wrote there). */
async function setStatus(supabase: Supabase, callbackId: string, status: string, note?: string): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (note) {
    const { data } = await supabase.from('callbacks').select('notes').eq('id', callbackId).maybeSingle();
    const existing = (data?.notes as string | null)?.trim();
    update.notes = (existing ? `${existing}\n${note}` : note).slice(0, 4000);
  }
  await supabase.from('callbacks').update(update).eq('id', callbackId);
}

/** Places one due callback. Returns what happened (for logging/tests). */
export async function dispatchCallback(supabase: Supabase, callback: Record<string, any>, now: Date = new Date()): Promise<'placed' | 'waiting' | 'skipped' | 'failed' | 'cancelled'> {
  // Claim it (scheduled/pending -> calling) so no other tick takes it.
  const originalStatus = callback.status as string;
  const { data: claimedRows } = await supabase
    .from('callbacks')
    .update({ status: 'calling' })
    .eq('id', callback.id)
    .eq('status', originalStatus)
    .select('id');
  if (!claimedRows || claimedRows.length === 0) return 'skipped';
  // Not callable right now (outside calling hours, lead busy): hand it back.
  const release = async () => {
    await supabase.from('callbacks').update({ status: originalStatus }).eq('id', callback.id);
  };

  const orgId = callback.organization_id as string;
  const { data: lead } = await supabase.from('leads').select('id, phone_normalized, is_dnc').eq('id', callback.lead_id).maybeSingle();
  if (!lead) {
    await setStatus(supabase, callback.id, 'failed', 'Lead no longer exists.');
    return 'failed';
  }
  const phone = (callback.phone_e164 as string | null) ?? lead.phone_normalized;
  const dnc = await findDncMatches(supabase as any, orgId, [phone]);
  if (lead.is_dnc || dnc.has(phone)) {
    await setStatus(supabase, callback.id, 'cancelled', 'Not called: number is on the Do Not Call list.');
    return 'cancelled';
  }
  const { data: active } = await supabase.from('calls').select('id').eq('lead_id', lead.id).in('status', ACTIVE_CALL_STATUSES).limit(1);
  if (active && active.length > 0) {
    await release();
    return 'waiting';
  }

  let campaignLeadId: string | null = null;
  let params: Parameters<typeof originateCall>[0] | null = null;

  if (callback.campaign_id) {
    const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', callback.campaign_id).maybeSingle();
    const context = campaign ? await loadCampaignCallContext(supabase, campaign) : null;
    if (context?.agentVersionRow && context.phoneNumberPool.length > 0) {
      const rules = context.callingRules;
      if (rules && (!isWithinCallingDay(rules.calling_days, rules.timezone, now) || !isWithinCallingWindow(rules.calling_window_start, rules.calling_window_end, rules.timezone, now))) {
        await release();
        return 'waiting';
      }
      // Claim the campaign lead so the campaign dialer can't dial them too.
      const { data: campaignLead } = await supabase.from('campaign_leads').select('id, status, attempt_count').eq('campaign_id', campaign!.id).eq('lead_id', lead.id).maybeSingle();
      if (campaignLead) {
        if (IN_FLIGHT_LEAD_STATUSES.includes(campaignLead.status)) {
          // The campaign dialer is calling them right now - that call is the callback.
          await setStatus(supabase, callback.id, 'completed', 'Called back by the campaign dialer.');
          return 'placed';
        }
        if (campaignLead.status === 'dnc') {
          await setStatus(supabase, callback.id, 'cancelled', 'Not called: lead is Do Not Call in this campaign.');
          return 'cancelled';
        }
        const { data: claimedLead } = await supabase
          .from('campaign_leads')
          .update({ status: 'dialing', attempt_count: (campaignLead.attempt_count ?? 0) + 1, last_attempt_at: now.toISOString() })
          .eq('id', campaignLead.id)
          .eq('status', campaignLead.status)
          .select('id');
        if (!claimedLead || claimedLead.length === 0) {
          await release();
          return 'waiting';
        }
        campaignLeadId = campaignLead.id as string;
      }
      params = {
        organizationId: orgId,
        engine: context.engine,
        agent: { id: context.version.ai_agent_id },
        version: context.agentVersionRow,
        phoneNumber: context.phoneNumberPool[0],
        customerNumber: phone,
        leadId: lead.id,
        campaignId: campaign!.id,
        createdBy: null,
        transferDestinationOverride: context.transferDestination,
        voiceOverride: context.voiceOverride,
        callingRulesOverride: context.callingRulesOverride,
        scriptIdOverride: context.scriptId,
        knowledgeBaseIdsOverride: context.knowledgeBaseIds,
        timezone: rules?.timezone ?? callback.timezone ?? null,
      };
    }
  }

  if (!params && callback.source_call_id) {
    // No (usable) campaign: call back the way the original call was made.
    const { data: source } = await supabase.from('calls').select('*').eq('id', callback.source_call_id).maybeSingle();
    const [{ data: version }, { data: phoneNumber }, { data: voice }] = await Promise.all([
      source?.ai_agent_version_id ? supabase.from('ai_agent_versions').select('*').eq('id', source.ai_agent_version_id).maybeSingle() : Promise.resolve({ data: null }),
      source?.phone_number_id ? supabase.from('phone_numbers').select('*').eq('id', source.phone_number_id).maybeSingle() : Promise.resolve({ data: null }),
      source?.voice_id ? supabase.from('voices').select('provider_key, provider_voice_id').eq('id', source.voice_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    if (source && version && phoneNumber) {
      params = {
        organizationId: orgId,
        engine: await resolveDefaultEngine(supabase, orgId),
        agent: { id: source.ai_agent_id },
        version,
        phoneNumber,
        customerNumber: phone,
        leadId: lead.id,
        campaignId: null,
        createdBy: null,
        transferDestinationOverride: source.transfer_destination_e164 ?? null,
        voiceOverride: voice ? { providerKey: voice.provider_key, providerVoiceId: voice.provider_voice_id } : null,
        timezone: callback.timezone ?? null,
      };
    }
  }

  if (!params) {
    await setStatus(supabase, callback.id, 'failed', 'Not called: no agent/phone number available to place the callback.');
    return 'failed';
  }

  try {
    const { call } = await originateCall(params);
    if (campaignLeadId) await supabase.from('campaign_leads').update({ last_call_id: call.id }).eq('id', campaignLeadId);
    await setStatus(supabase, callback.id, 'completed', `Called back (call ${call.id}).`);
    return 'placed';
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Call could not be placed.';
    if (campaignLeadId) await supabase.from('campaign_leads').update({ status: 'retry_pending', final_disposition: message }).eq('id', campaignLeadId);
    await setStatus(supabase, callback.id, 'failed', `Callback failed: ${message}`.slice(0, 1000));
    // eslint-disable-next-line no-console
    console.error('callbackDispatcher: callback', callback.id, 'failed -', message);
    return 'failed';
  }
}

export async function runCallbackDispatchTick(now: Date = new Date()): Promise<number> {
  const supabase = getSupabaseAdmin();
  const staleBefore = new Date(now.getTime() - MAX_OVERDUE_MS).toISOString();
  const { data: stale } = await supabase
    .from('callbacks')
    .select('id')
    .in('status', ['scheduled', 'pending'])
    .eq('assigned_to', 'ai')
    .lt('scheduled_at', staleBefore)
    .limit(100);
  for (const cb of stale ?? []) {
    await setStatus(supabase, cb.id as string, 'failed', 'Missed: more than 3 days overdue, so it was not called automatically. Reschedule it if still needed.');
  }

  const { data, error } = await supabase
    .from('callbacks')
    .select('*')
    .in('status', ['scheduled', 'pending'])
    .eq('assigned_to', 'ai')
    .lte('scheduled_at', now.toISOString())
    .gte('scheduled_at', staleBefore)
    .order('scheduled_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;
  let placed = 0;
  for (const callback of data ?? []) {
    if ((await dispatchCallback(supabase, callback, now)) === 'placed') placed += 1;
  }
  return placed;
}

let handle: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startCallbackDispatcher(): void {
  if (handle) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runCallbackDispatchTick();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('callbackDispatcher tick failed', err);
    } finally {
      running = false;
    }
  };
  void tick();
  handle = setInterval(() => void tick(), TICK_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
}
