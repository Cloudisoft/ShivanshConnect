/**
 * Phase 13: the SMS campaign dispatch engine (master spec section 38).
 * Mirrors campaignDispatcher.ts's exact architecture - a queue-based,
 * throttled `setInterval` tick loop, never a `for each lead: send()`
 * loop - see that file's header comment for the full BullMQ-drop-in
 * rationale, which applies unchanged here.
 *
 * Materialization strategy: `sms_messages` rows are PRE-MATERIALIZED
 * (one row per lead in the campaign's lead list) the first time a
 * campaign is started (see routes/smsCampaigns.ts's `/start` handler),
 * not generated lazily per tick. This is the documented choice from the
 * schema migration's header comment: it matches the
 * UNIQUE(sms_campaign_id, lead_id) constraint's dedup intent exactly
 * (every lead gets at most one row, decided once) and makes "how many
 * remain" a plain COUNT(status='queued') query.
 *
 * Each tick:
 *   1. For every `sending`-status campaign, computes remaining
 *      throttle_per_minute capacity via the same rolling-counter
 *      technique campaignDispatcher.ts uses for calls-per-minute.
 *   2. Atomically claims a batch of `queued` sms_messages rows (CAS
 *      UPDATE ... WHERE status = 'queued' ... RETURNING - the same
 *      "claim work, never lose it, never double-process it" contract).
 *   3. Re-checks DNC (phone) suppression per-lead right before sending -
 *      never trusts a materialization-time check alone, since a lead can
 *      be added to DNC after the campaign started.
 *   4. Sends via the resolved SMS adapter (lib/sms) and records the
 *      real result.
 *   5. Marks the campaign `completed` once no `queued` rows remain.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { resolveSmsAdapterForOrg } from '../lib/sms/index.js';
import { renderTemplate } from '../lib/promptVariables.js';
import { isOnDncList } from '../lib/leadHelpers.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const DISPATCH_TICK_MS = Number.parseInt(process.env.SMS_DISPATCH_INTERVAL_MS ?? '', 10) || 3000;
const CLAIM_BATCH_SIZE = 20;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** Rolling per-campaign per-minute send counter - identical technique to
 * campaignDispatcher.ts's perMinuteCounters. */
const perMinuteCounters = new Map<string, { windowStartMs: number; count: number }>();

export function perMinuteRemaining(campaignId: string, limit: number): number {
  const nowMs = Date.now();
  const entry = perMinuteCounters.get(campaignId);
  if (!entry || nowMs - entry.windowStartMs >= 60_000) {
    perMinuteCounters.set(campaignId, { windowStartMs: nowMs, count: 0 });
    return limit;
  }
  return Math.max(0, limit - entry.count);
}

export function recordSend(campaignId: string): void {
  const entry = perMinuteCounters.get(campaignId);
  if (entry) entry.count += 1;
  else perMinuteCounters.set(campaignId, { windowStartMs: Date.now(), count: 1 });
}

/** Resets the in-memory throttle counters - test-only, mirrors what a
 * fresh process would naturally have. */
export function __resetSmsDispatcherCountersForTests(): void {
  perMinuteCounters.clear();
}

/**
 * Materializes sms_messages for every lead attached to a campaign's lead
 * list (or, if no list is set, every lead in the org - a campaign should
 * always have a lead_list_id in practice, but this keeps the function
 * total). Skips leads already materialized (UNIQUE constraint is the
 * final backstop, this pre-check just avoids noisy duplicate-key
 * roundtrips). Skips DNC leads entirely - a DNC lead never gets a queued
 * row in the first place.
 */
export async function materializeSmsMessages(supabase: Supabase, campaign: Record<string, any>): Promise<number> {
  const orgId = campaign.organization_id as string;

  let leadIds: string[] = [];
  if (campaign.lead_list_id) {
    const { data: members } = await supabase.from('lead_list_members').select('lead_id').eq('lead_list_id', campaign.lead_list_id);
    leadIds = (members ?? []).map((m: any) => m.lead_id);
  }
  if (leadIds.length === 0) return 0;

  const { data: leads } = await supabase.from('leads').select('id, first_name, last_name, phone_normalized, email, custom_fields, is_dnc').in('id', leadIds).eq('organization_id', orgId);

  const { data: existing } = await supabase.from('sms_messages').select('lead_id').eq('sms_campaign_id', campaign.id);
  const existingIds = new Set((existing ?? []).map((r: any) => r.lead_id));

  const rows: Record<string, any>[] = [];
  for (const lead of leads ?? []) {
    if (existingIds.has(lead.id)) continue;
    if (lead.is_dnc) continue; // never materialize a message for a DNC lead
    if (!lead.phone_normalized) continue;
    const body = renderTemplate(campaign.message_template, {
      first_name: lead.first_name,
      last_name: lead.last_name,
      phone: lead.phone_normalized,
      email: lead.email ?? undefined,
      custom_field: lead.custom_fields ?? {},
    });
    rows.push({
      sms_campaign_id: campaign.id,
      organization_id: orgId,
      lead_id: lead.id,
      phone_e164: lead.phone_normalized,
      rendered_body: body,
      status: 'queued',
    });
  }

  const BATCH_SIZE = 500;
  let materialized = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('sms_messages').insert(batch);
    // A unique-constraint race (two concurrent materializations) is not
    // fatal - just means another caller already inserted these rows.
    if (error && (error as any).code !== '23505') throw error;
    materialized += batch.length;
  }
  return materialized;
}

async function claimSmsMessage(supabase: Supabase, id: string): Promise<Record<string, any> | null> {
  const { data } = await supabase.from('sms_messages').update({ status: 'sent' }).eq('id', id).eq('status', 'queued').select('*');
  const rows = (data as Record<string, any>[] | null) ?? [];
  return rows[0] ?? null;
}

export interface ProcessSmsCampaignResult {
  sent: number;
  failed: number;
}

/** Processes one `sending` SMS campaign for one tick. Never throws - a
 * per-message failure is recorded on that row and the loop continues. */
export async function processSmsCampaign(campaign: Record<string, any>): Promise<ProcessSmsCampaignResult> {
  const supabase = getSupabaseAdmin();
  const orgId = campaign.organization_id as string;
  let sent = 0;
  let failed = 0;

  if (campaign.status !== 'sending') return { sent, failed };

  const capacity = Math.min(CLAIM_BATCH_SIZE, perMinuteRemaining(campaign.id, campaign.throttle_per_minute ?? 30));
  if (capacity <= 0) return { sent, failed };

  const { data: candidates } = await supabase.from('sms_messages').select('*').eq('sms_campaign_id', campaign.id).eq('status', 'queued').order('created_at', { ascending: true }).limit(capacity);
  const rows: Record<string, any>[] = candidates ?? [];

  if (rows.length === 0) {
    // Nothing left queued - if nothing is still queued anywhere, the
    // campaign is done.
    const { count: remaining } = await supabase.from('sms_messages').select('id', { count: 'exact', head: true }).eq('sms_campaign_id', campaign.id).eq('status', 'queued');
    if ((remaining ?? 0) === 0) {
      await supabase.from('sms_campaigns').update({ status: 'completed' }).eq('id', campaign.id).eq('status', 'sending');
    }
    return { sent, failed };
  }

  const { data: phoneNumber } = await supabase.from('phone_numbers').select('*').eq('id', campaign.phone_number_id).maybeSingle();
  if (!phoneNumber) return { sent, failed };

  let adapter;
  try {
    adapter = await resolveSmsAdapterForOrg(supabase, orgId, phoneNumber.provider_key);
  } catch (err) {
    // Provider not connected - fail every candidate this tick rather than
    // spinning forever; a human must reconnect the provider.
    for (const row of rows) {
      await supabase.from('sms_messages').update({ status: 'failed', error: err instanceof Error ? err.message : 'SMS provider not configured.' }).eq('id', row.id).eq('status', 'queued');
      failed += 1;
    }
    return { sent, failed };
  }

  for (const row of rows) {
    // Real DNC re-check right before send (spec 60's opt-out handling) -
    // never trusts materialization-time state alone.
    const isDnc = await isOnDncList(supabase as any, orgId, row.phone_e164);
    if (isDnc) {
      await supabase.from('sms_messages').update({ status: 'failed', error: 'Recipient is on the Do Not Call list.' }).eq('id', row.id).eq('status', 'queued');
      failed += 1;
      continue;
    }

    const claimed = await claimSmsMessage(supabase, row.id);
    if (!claimed) continue; // lost a race to another tick/process - never double-send

    try {
      const result = await adapter.sendSms(phoneNumber.phone_number, row.phone_e164, row.rendered_body);
      await supabase.from('sms_messages').update({ status: 'sent', provider_message_id: result.providerMessageId, sent_at: new Date().toISOString() }).eq('id', row.id);
      sent += 1;
      recordSend(campaign.id);
    } catch (err) {
      await supabase.from('sms_messages').update({ status: 'failed', error: err instanceof Error ? err.message : 'SMS send failed.' }).eq('id', row.id);
      failed += 1;
    }
  }

  return { sent, failed };
}

export async function runSmsDispatchTick(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: campaigns } = await supabase.from('sms_campaigns').select('*').eq('status', 'sending');
  for (const campaign of campaigns ?? []) {
    try {
      await processSmsCampaign(campaign);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('SMS dispatch tick failed for campaign', campaign.id, err);
    }
  }
}

export function startSmsDispatcher(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    runSmsDispatchTick()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('SMS dispatch tick failed', err);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, DISPATCH_TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopSmsDispatcher(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
