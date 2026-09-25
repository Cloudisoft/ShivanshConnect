/**
 * Phase 7: the campaign execution engine (master spec sections 7, 10, 11).
 *
 *   Campaign -> Eligibility Queue -> Dial Queue -> Worker Pool -> Vapi/
 *   pipecat -> Webhook Events -> Event Processor -> Call State ->
 *   Disposition -> Analytics
 *
 * Redis/BullMQ is not wired up until Phase 15, so this runs NOW using the
 * same `setImmediate`/in-process-async pattern Phases 2/3/6 already
 * established (see services/importLeads.ts's header comment), but
 * structured as a genuine drop-in for a real queue later:
 *   - `runDispatchTick()` is the one entry point a BullMQ repeatable job
 *     would call instead of this module's own `setInterval`.
 *   - `processCampaign()` is what a per-campaign BullMQ job processor
 *     would become.
 *   - The atomic CAS claim (`claimCampaignLead`) is exactly the same
 *     "claim work, never lose it, never double-process it" contract a
 *     real queue's job-lock gives you for free - implemented here via a
 *     single conditional UPDATE ... WHERE status = <expected> ... RETURNING,
 *     which Postgres executes atomically per row regardless of how many
 *     concurrent ticks race to claim the same lead.
 *
 * A tick-overlap guard (`tickInFlight`) prevents two overlapping
 * `setInterval` firings from running the dispatch loop concurrently in
 * THIS process; the CAS claim is what protects against races across
 * ticks/processes even without that guard, which is why the invariant
 * (no lead is ever double-dialed) is tested by exercising
 * `processCampaign()` concurrently, not just by trusting the guard.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { originateCall, resolveDefaultEngine } from './callOrigination.js';
import { effectiveConcurrency, evaluateLeadEligibility, getWorkerPoolCapacity } from './leadEligibility.js';
import { findDncMatches } from '../lib/leadHelpers.js';
import { callEventBus } from '../lib/callStateMachine.js';
import type { CampaignCallingRulesSnapshot, CampaignDispositionRulesSnapshot } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** calls.status values that count as "this call is still occupying a
 * worker slot" - anything not yet in a terminal state. */
export const ACTIVE_CALL_STATUSES = [
  'queued',
  'dialing',
  'ringing',
  'answered',
  'in_progress',
  'voicemail',
  'answering_machine',
  'transfer_pending',
  'transferring',
];

const DISPATCH_TICK_MS = Number.parseInt(process.env.CAMPAIGN_DISPATCH_INTERVAL_MS ?? '', 10) || 3000;
const CANDIDATE_BATCH_MULTIPLIER = 5;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** Rolling per-campaign per-minute dispatch counter - bounds
 * `calls_per_minute_limit` without needing a persisted table (a real
 * queue would use its own rate limiter; this is the in-process
 * equivalent). Resets its window every 60s per campaign. */
const perMinuteCounters = new Map<string, { windowStartMs: number; count: number }>();

function perMinuteRemaining(campaignId: string, limit: number | null): number {
  if (limit === null) return Number.POSITIVE_INFINITY;
  const nowMs = Date.now();
  const entry = perMinuteCounters.get(campaignId);
  if (!entry || nowMs - entry.windowStartMs >= 60_000) {
    perMinuteCounters.set(campaignId, { windowStartMs: nowMs, count: 0 });
    return limit;
  }
  return Math.max(0, limit - entry.count);
}

function recordDispatch(campaignId: string): void {
  const entry = perMinuteCounters.get(campaignId);
  if (entry) entry.count += 1;
  else perMinuteCounters.set(campaignId, { windowStartMs: Date.now(), count: 1 });
}

/** In-process round-robin cursor per campaign for its phone number pool
 * (campaign_phone_numbers) - same in-process-counter pattern as
 * perMinuteCounters above, not a persisted queue. Resets to 0 on a
 * process restart, which only means rotation starts over from the first
 * number again, never a correctness issue (every number in the pool is
 * equally valid to dial from). */
const phoneNumberRotationCursors = new Map<string, number>();

function nextPhoneNumberFromPool(campaignId: string, pool: Record<string, any>[]): Record<string, any> | null {
  if (pool.length === 0) return null;
  const cursor = phoneNumberRotationCursors.get(campaignId) ?? 0;
  const number = pool[cursor % pool.length];
  phoneNumberRotationCursors.set(campaignId, cursor + 1);
  return number;
}

async function logSkip(supabase: Supabase, campaignId: string, orgId: string, leadId: string, reasonCode: string, reasonMessage: string): Promise<void> {
  await supabase.from('campaign_lead_skip_log').insert({
    campaign_id: campaignId,
    organization_id: orgId,
    lead_id: leadId,
    reason_code: reasonCode,
    reason_message: reasonMessage,
  });
}

/** Atomic compare-and-swap claim: only succeeds if the row's status is
 * STILL `expectedStatus` at the moment Postgres executes the UPDATE. Two
 * concurrent callers racing for the same row: exactly one gets a non-empty
 * `data` array back, per Postgres's own row-level locking during an
 * UPDATE - no client-side locking needed. */
async function claimCampaignLead(
  supabase: Supabase,
  campaignLeadId: string,
  expectedStatus: string,
  nextAttemptCount: number,
  nowIso: string,
): Promise<Record<string, any> | null> {
  const { data } = await supabase
    .from('campaign_leads')
    .update({ status: 'dialing', attempt_count: nextAttemptCount, last_attempt_at: nowIso })
    .eq('id', campaignLeadId)
    .eq('status', expectedStatus)
    .select('*');
  const rows = (data as Record<string, any>[] | null) ?? [];
  return rows[0] ?? null;
}

export interface ProcessCampaignResult {
  dispatched: number;
  skipped: number;
}

/** Processes ONE running campaign for one tick: computes capacity,
 * pulls the next eligible batch, re-checks eligibility per-lead, claims
 * (CAS) and originates calls up to capacity. Never throws - a per-lead or
 * per-campaign failure is logged and the loop continues, so one broken
 * campaign/lead never stalls every other campaign's dispatch. */
export async function processCampaign(campaign: Record<string, any>): Promise<ProcessCampaignResult> {
  const supabase = getSupabaseAdmin();
  const orgId = campaign.organization_id as string;
  let dispatched = 0;
  let skipped = 0;

  if (campaign.status !== 'running') return { dispatched, skipped };
  if (!campaign.current_version_id) return { dispatched, skipped };

  const [{ data: dialingSettings }, { data: version }] = await Promise.all([
    supabase.from('dialing_settings').select('*').eq('organization_id', orgId).eq('is_default', true).maybeSingle(),
    supabase.from('campaign_versions').select('*').eq('id', campaign.current_version_id).maybeSingle(),
  ]);
  if (!version) return { dispatched, skipped };

  const callingRules = version.calling_rules as CampaignCallingRulesSnapshot;
  const dispositionRules = version.disposition_rules as CampaignDispositionRulesSnapshot;
  const maxAttempts = dispositionRules?.max_attempts ?? dialingSettings?.max_attempts ?? 3;

  const { count: activeCount } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id)
    .in('status', ACTIVE_CALL_STATUSES);

  const effConcurrency = effectiveConcurrency({
    campaignConcurrencyLimit: campaign.concurrency_limit,
    orgMaxConcurrency: dialingSettings?.max_concurrency ?? 25,
    workerPoolCapacity: getWorkerPoolCapacity(),
  });
  let capacity = effConcurrency - (activeCount ?? 0);
  const perMinuteLimit = campaign.calls_per_minute_limit ?? dialingSettings?.calls_per_minute ?? null;
  capacity = Math.min(capacity, perMinuteRemaining(campaign.id, perMinuteLimit));
  if (capacity <= 0) return { dispatched, skipped };

  const nowIso = new Date().toISOString();
  const { data: candidates } = await supabase
    .from('campaign_leads')
    .select('*')
    .eq('campaign_id', campaign.id)
    .in('status', ['pending', 'retry_pending'])
    .or(`next_eligible_at.is.null,next_eligible_at.lte.${nowIso}`)
    .order('next_eligible_at', { ascending: true })
    .limit(capacity * CANDIDATE_BATCH_MULTIPLIER);

  const rows: Record<string, any>[] = candidates ?? [];
  if (rows.length === 0) return { dispatched, skipped };

  const leadIds = rows.map((r) => r.lead_id);
  const { data: leads } = await supabase.from('leads').select('id, phone_normalized, is_dnc, organization_id').in('id', leadIds);
  const leadsById = new Map((leads ?? []).map((l: any) => [l.id, l]));

  const phones = (leads ?? []).map((l: any) => l.phone_normalized).filter(Boolean);
  const dncMatches = await findDncMatches(supabase as any, orgId, phones);

  const { data: activeCalls } = await supabase.from('calls').select('lead_id').in('lead_id', leadIds).in('status', ACTIVE_CALL_STATUSES);
  const leadsWithActiveCall = new Set((activeCalls ?? []).map((c: any) => c.lead_id));

  // Resolved once per campaign, not per lead: the whole point of the
  // snapshot is that every call this tick uses the SAME locked-in agent
  // version/voice/transfer number. The phone number pool is the one
  // exception - a campaign can dial from several numbers (any mix of
  // providers, see migration 00000000000056), so each call in the loop
  // below rotates to the next one via nextPhoneNumberFromPool() rather
  // than every call this tick using the same fixed number.
  let agentVersionRow: Record<string, any> | null = null;
  let voiceOverride: { providerKey: string; providerVoiceId: string } | null = null;
  let engine: 'vapi' | 'pipecat' = 'vapi';
  if (version.ai_agent_version_id) {
    const { data } = await supabase.from('ai_agent_versions').select('*').eq('id', version.ai_agent_version_id).maybeSingle();
    agentVersionRow = data;
  }
  const { data: poolRows } = await supabase.from('campaign_phone_numbers').select('phone_numbers(*)').eq('campaign_id', campaign.id);
  let phoneNumberPool: Record<string, any>[] = ((poolRows ?? []) as any[]).map((row) => row.phone_numbers).filter(Boolean);
  if (phoneNumberPool.length === 0 && campaign.phone_number_id) {
    // Legacy fallback: a campaign that predates the pool (or whose pool
    // row was somehow never backfilled) still dials from its single
    // configured number exactly as before.
    const { data } = await supabase.from('phone_numbers').select('*').eq('id', campaign.phone_number_id).maybeSingle();
    if (data) phoneNumberPool = [data];
  }
  if (version.voice_id) {
    const { data } = await supabase.from('voices').select('provider_key, provider_voice_id').eq('id', version.voice_id).maybeSingle();
    if (data) voiceOverride = { providerKey: data.provider_key, providerVoiceId: data.provider_voice_id };
  }
  engine = await resolveDefaultEngine(supabase, orgId);

  const now = new Date();
  for (const candidate of rows) {
    if (dispatched >= capacity) break;
    const lead = leadsById.get(candidate.lead_id);
    if (!lead) {
      await logSkip(supabase, campaign.id, orgId, candidate.lead_id, 'lead_missing', 'Lead record could not be found.');
      skipped += 1;
      continue;
    }

    const eligibility = evaluateLeadEligibility({
      campaignStatus: campaign.status,
      callingRules,
      maxAttempts,
      campaignLeadStatus: candidate.status,
      attemptCount: candidate.attempt_count,
      nextEligibleAt: candidate.next_eligible_at,
      isDnc: Boolean(lead.is_dnc) || dncMatches.has(lead.phone_normalized),
      hasOtherActiveCall: leadsWithActiveCall.has(candidate.lead_id),
      now,
    });

    if (!eligibility.eligible) {
      skipped += 1;
      await logSkip(supabase, campaign.id, orgId, candidate.lead_id, eligibility.reasonCode, eligibility.reasonMessage);
      if (eligibility.reasonCode === 'lead_dnc') {
        await supabase.from('campaign_leads').update({ status: 'dnc', final_disposition: 'dnc' }).eq('id', candidate.id).eq('status', candidate.status);
      } else if (eligibility.reasonCode === 'max_attempts_reached') {
        await supabase.from('campaign_leads').update({ status: 'failed', final_disposition: 'max_attempts_reached' }).eq('id', candidate.id).eq('status', candidate.status);
      }
      continue;
    }

    if (!agentVersionRow || phoneNumberPool.length === 0) {
      await logSkip(supabase, campaign.id, orgId, candidate.lead_id, 'campaign_misconfigured', 'Campaign is missing its agent version or phone number.');
      skipped += 1;
      continue;
    }

    const claimed = await claimCampaignLead(supabase, candidate.id, candidate.status, candidate.attempt_count + 1, nowIso);
    if (!claimed) {
      // Another tick/process claimed this row first between our select and
      // our CAS update - not an error, just a lost race. Never double-dial.
      continue;
    }

    const phoneNumberRow = nextPhoneNumberFromPool(campaign.id, phoneNumberPool)!;

    try {
      const { call } = await originateCall({
        organizationId: orgId,
        engine,
        agent: { id: version.ai_agent_id },
        version: agentVersionRow,
        phoneNumber: phoneNumberRow,
        customerNumber: lead.phone_normalized,
        leadId: lead.id,
        campaignId: campaign.id,
        createdBy: null,
        transferDestinationOverride: version.transfer_number_e164 ?? campaign.transfer_number_e164 ?? null,
        voiceOverride,
        callingRulesOverride: callingRules
          ? {
              voicemail_detection_enabled: callingRules.voicemail_detection_enabled,
              voicemail_message: callingRules.voicemail_message,
              leave_voicemail: callingRules.leave_voicemail,
              background_noise: callingRules.background_noise,
            }
          : null,
      });
      await supabase.from('campaign_leads').update({ last_call_id: call.id }).eq('id', claimed.id);
      dispatched += 1;
      recordDispatch(campaign.id);
    } catch (err) {
      // originateCall already marked the `calls` row failed - reflect
      // that on the campaign_leads row too rather than leaving it stuck
      // in 'dialing' forever. Retryable per the same disposition rules a
      // webhook-driven failure would use.
      const message = err instanceof Error ? err.message : 'Call origination failed.';
      await supabase
        .from('campaign_leads')
        .update({ status: candidate.attempt_count + 1 >= maxAttempts ? 'failed' : 'retry_pending', final_disposition: message })
        .eq('id', claimed.id);
      await logSkip(supabase, campaign.id, orgId, candidate.lead_id, 'origination_failed', message);
      skipped += 1;
    }
  }

  return { dispatched, skipped };
}

/** Runs one full dispatch tick across every currently-running campaign,
 * regardless of organization (the dispatcher is a single process-wide
 * loop; org isolation is enforced per-campaign by every query above being
 * scoped to that campaign's own organization_id). Never throws. */
export async function runDispatchTick(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: campaigns } = await supabase.from('campaigns').select('*').eq('status', 'running');
  for (const campaign of campaigns ?? []) {
    try {
      await processCampaign(campaign);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Campaign dispatch tick failed for campaign', campaign.id, err);
    }
  }
}

/** Runs a tick right now if one isn't already running, guarded by the
 * same `tickInFlight` flag the interval uses - shared by both the
 * regular timer and the event-driven trigger below, so they can never
 * run concurrently with each other either. */
function triggerDispatchTick(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  runDispatchTick()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Campaign dispatch tick failed', err);
    })
    .finally(() => {
      tickInFlight = false;
    });
}

let onCallTerminal: ((event: unknown) => void) | null = null;

/** Starts the in-process dispatch loop. Guarded against overlapping ticks
 * (`tickInFlight`) so a slow tick never runs concurrently with itself in
 * this process - see this module's header comment for why that guard is
 * a convenience, not the actual race-safety mechanism.
 *
 * Also fires an immediate tick the moment ANY call reaches a terminal
 * status - a campaign call ending frees a concurrency slot, and waiting
 * out the rest of the current DISPATCH_TICK_MS window before that slot
 * got refilled was a real, avoidable dead spot ("at concurrency 5, one
 * call ends, the next batch call should be placed") on top of the
 * regular interval, which now serves purely as the fallback safety net.
 * Cheap even when the ended call wasn't part of a running campaign at
 * all: a tick that finds no capacity anywhere just returns fast. */
export function startCampaignDispatcher(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(triggerDispatchTick, DISPATCH_TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();

  onCallTerminal = () => triggerDispatchTick();
  callEventBus.on('call.terminal', onCallTerminal);
}

export function stopCampaignDispatcher(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  if (onCallTerminal) {
    callEventBus.off('call.terminal', onCallTerminal);
    onCallTerminal = null;
  }
}
