/**
 * Phase 13: the email campaign dispatch engine (master spec section 40).
 * Same architecture as services/smsDispatcher.ts (which itself mirrors
 * campaignDispatcher.ts) - see that file's header comment for the full
 * rationale. This file only documents what's different for email:
 *
 *   - Recipients come from EITHER `recipient_lead_list_id` (a fixed lead
 *     list) OR `recipient_filter` (currently `{ campaign_id, disposition }`
 *     - "every lead in campaign X with final_disposition Y" - resolved
 *     against campaign_leads). Exactly one is expected to be set (the
 *     schema doesn't enforce it - see the create-campaign Zod schema).
 *   - Suppression is checked against `email_suppressions`
 *     (lib/emailSuppression.ts), NOT `dnc_entries` - an email opt-out and
 *     a phone DNC entry are deliberately independent (spec 60).
 *   - HONESTY LIMIT: raw SMTP gives no delivery/bounce/reply signal at
 *     all. This dispatcher only ever writes 'sent' (accepted by the SMTP
 *     server) or 'failed' (nodemailer/SMTP rejected it) -
 *     'delivered'/'bounced'/'replied' remain valid schema values for a
 *     FUTURE transactional-email-provider webhook integration (e.g.
 *     SendGrid/Postmark/SES), which is out of this phase's scope. Never
 *     faked here - see README's Phase 13 writeup.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { sendEmail, type SmtpSettingsRow } from './smtpProvider.js';
import { renderTemplate } from '../lib/promptVariables.js';
import { isEmailSuppressed } from '../lib/emailSuppression.js';
import { SmtpNotConfiguredError } from './smtpProvider.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const DISPATCH_TICK_MS = Number.parseInt(process.env.EMAIL_DISPATCH_INTERVAL_MS ?? '', 10) || 3000;
const CLAIM_BATCH_SIZE = 20;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

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

export function __resetEmailDispatcherCountersForTests(): void {
  perMinuteCounters.clear();
}

/** Resolves the lead ids a campaign's recipient configuration points at -
 * either a fixed lead list, or a filter against campaign_leads
 * (`{ campaign_id, disposition }`). */
async function resolveRecipientLeadIds(supabase: Supabase, orgId: string, campaign: Record<string, any>): Promise<string[]> {
  if (campaign.recipient_lead_list_id) {
    const { data } = await supabase.from('lead_list_members').select('lead_id').eq('lead_list_id', campaign.recipient_lead_list_id);
    return (data ?? []).map((m: any) => m.lead_id);
  }
  const filter = campaign.recipient_filter as { campaign_id?: string; disposition?: string } | null;
  if (filter?.campaign_id) {
    let builder = supabase.from('campaign_leads').select('lead_id').eq('campaign_id', filter.campaign_id).eq('organization_id', orgId);
    if (filter.disposition) builder = builder.eq('final_disposition', filter.disposition);
    const { data } = await builder;
    return (data ?? []).map((r: any) => r.lead_id);
  }
  return [];
}

/** Materializes email_messages for every resolved recipient lead with a
 * real email address, skipping suppressed addresses and leads already
 * materialized. */
export async function materializeEmailMessages(supabase: Supabase, campaign: Record<string, any>): Promise<number> {
  const orgId = campaign.organization_id as string;
  const leadIds = await resolveRecipientLeadIds(supabase, orgId, campaign);
  if (leadIds.length === 0) return 0;

  const { data: leads } = await supabase.from('leads').select('id, first_name, last_name, phone_normalized, email, custom_fields').in('id', leadIds).eq('organization_id', orgId);
  const { data: existing } = await supabase.from('email_messages').select('lead_id').eq('email_campaign_id', campaign.id);
  const existingIds = new Set((existing ?? []).map((r: any) => r.lead_id));

  const rows: Record<string, any>[] = [];
  for (const lead of leads ?? []) {
    if (existingIds.has(lead.id)) continue;
    if (!lead.email) continue;
    if (await isEmailSuppressed(supabase as any, orgId, lead.email)) continue;
    const context = {
      first_name: lead.first_name,
      last_name: lead.last_name,
      phone: lead.phone_normalized,
      email: lead.email,
      custom_field: lead.custom_fields ?? {},
    };
    rows.push({
      email_campaign_id: campaign.id,
      organization_id: orgId,
      lead_id: lead.id,
      recipient_email: lead.email,
      rendered_subject: renderTemplate(campaign.subject, context),
      rendered_html: renderTemplate(campaign.html_body, context),
      status: 'queued',
    });
  }

  const BATCH_SIZE = 500;
  let materialized = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('email_messages').insert(batch);
    if (error && (error as any).code !== '23505') throw error;
    materialized += batch.length;
  }
  return materialized;
}

async function claimEmailMessage(supabase: Supabase, id: string): Promise<Record<string, any> | null> {
  const { data } = await supabase.from('email_messages').update({ status: 'sent' }).eq('id', id).eq('status', 'queued').select('*');
  const rows = (data as Record<string, any>[] | null) ?? [];
  return rows[0] ?? null;
}

export interface ProcessEmailCampaignResult {
  sent: number;
  failed: number;
}

export async function processEmailCampaign(campaign: Record<string, any>): Promise<ProcessEmailCampaignResult> {
  const supabase = getSupabaseAdmin();
  const orgId = campaign.organization_id as string;
  let sent = 0;
  let failed = 0;

  if (campaign.status !== 'sending') return { sent, failed };

  const capacity = Math.min(CLAIM_BATCH_SIZE, perMinuteRemaining(campaign.id, campaign.throttle_per_minute ?? 30));
  if (capacity <= 0) return { sent, failed };

  const { data: candidates } = await supabase.from('email_messages').select('*').eq('email_campaign_id', campaign.id).eq('status', 'queued').order('created_at', { ascending: true }).limit(capacity);
  const rows: Record<string, any>[] = candidates ?? [];

  if (rows.length === 0) {
    const { count: remaining } = await supabase.from('email_messages').select('id', { count: 'exact', head: true }).eq('email_campaign_id', campaign.id).eq('status', 'queued');
    if ((remaining ?? 0) === 0) {
      await supabase.from('email_campaigns').update({ status: 'completed' }).eq('id', campaign.id).eq('status', 'sending');
    }
    return { sent, failed };
  }

  const { data: smtpSettings } = await supabase.from('smtp_settings').select('*').eq('organization_id', orgId).maybeSingle();
  if (!smtpSettings) {
    for (const row of rows) {
      await supabase.from('email_messages').update({ status: 'failed', error: new SmtpNotConfiguredError().message }).eq('id', row.id).eq('status', 'queued');
      failed += 1;
    }
    return { sent, failed };
  }

  for (const row of rows) {
    // Real-time re-check right before send - never trusts
    // materialization-time state alone.
    if (await isEmailSuppressed(supabase as any, orgId, row.recipient_email)) {
      await supabase.from('email_messages').update({ status: 'failed', error: 'Recipient has opted out of email.' }).eq('id', row.id).eq('status', 'queued');
      failed += 1;
      continue;
    }

    const claimed = await claimEmailMessage(supabase, row.id);
    if (!claimed) continue; // lost a race - never double-send

    try {
      await sendEmail(smtpSettings as SmtpSettingsRow, { to: row.recipient_email, subject: row.rendered_subject, html: row.rendered_html });
      await supabase.from('email_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', row.id);
      sent += 1;
      recordSend(campaign.id);
    } catch (err) {
      await supabase.from('email_messages').update({ status: 'failed', error: err instanceof Error ? err.message : 'Email send failed.' }).eq('id', row.id);
      failed += 1;
    }
  }

  return { sent, failed };
}

export async function runEmailDispatchTick(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: campaigns } = await supabase.from('email_campaigns').select('*').eq('status', 'sending');
  for (const campaign of campaigns ?? []) {
    try {
      await processEmailCampaign(campaign);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Email dispatch tick failed for campaign', campaign.id, err);
    }
  }
}

export function startEmailDispatcher(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    runEmailDispatchTick()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Email dispatch tick failed', err);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, DISPATCH_TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopEmailDispatcher(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
