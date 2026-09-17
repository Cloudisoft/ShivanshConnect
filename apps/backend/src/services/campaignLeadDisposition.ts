/**
 * Phase 7: hooks the Phase 6 webhook event processor's call-state
 * transitions into campaign_leads. Called from routes/webhooks.ts right
 * after a call's status is actually updated to a terminal state
 * (completed/failed/transferred/dnc/cancelled/transfer_failed) - never
 * duplicated dialing logic, just the disposition/retry bookkeeping spec
 * section 52 describes.
 */
import type { getSupabaseAdmin } from '../lib/supabase.js';
import { computeNextEligibleAt } from './leadEligibility.js';
import type { CampaignDispositionRulesSnapshot } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export const TERMINAL_CALL_STATUSES = ['completed', 'failed', 'transferred', 'dnc', 'cancelled', 'transfer_failed'];

const DEFAULT_RETRY_ON = ['no-answer', 'busy', 'customer-did-not-answer', 'twilio-failed', 'pipeline-error', 'assistant-error'];

export async function applyCallOutcomeToCampaignLead(
  supabase: Supabase,
  call: { id: string; organization_id: string; campaign_id: string | null; lead_id: string | null; ended_reason: string | null },
  nextStatus: string,
): Promise<void> {
  if (!call.campaign_id || !call.lead_id) return;
  if (!TERMINAL_CALL_STATUSES.includes(nextStatus)) return;

  const { data: campaignLead } = await supabase
    .from('campaign_leads')
    .select('*')
    .eq('campaign_id', call.campaign_id)
    .eq('lead_id', call.lead_id)
    .maybeSingle();
  if (!campaignLead) return;
  // Only ever update the row this exact call is the most recent attempt
  // for - a delayed/duplicate webhook for a superseded call must never
  // clobber a lead's already-more-current state.
  if (campaignLead.last_call_id && campaignLead.last_call_id !== call.id) return;

  const { data: campaign } = await supabase.from('campaigns').select('id, current_version_id, lead_cooldown_minutes').eq('id', call.campaign_id).maybeSingle();
  const { data: dialingSettings } = await supabase.from('dialing_settings').select('*').eq('organization_id', call.organization_id).eq('is_default', true).maybeSingle();

  let dispositionRules: CampaignDispositionRulesSnapshot | null = null;
  if (campaign?.current_version_id) {
    const { data: version } = await supabase.from('campaign_versions').select('disposition_rules').eq('id', campaign.current_version_id).maybeSingle();
    dispositionRules = (version?.disposition_rules as CampaignDispositionRulesSnapshot) ?? null;
  }
  const retryOn = dispositionRules?.retry_on ?? DEFAULT_RETRY_ON;
  const maxAttempts = dispositionRules?.max_attempts ?? dialingSettings?.max_attempts ?? 3;
  const retryDelayMinutes = dispositionRules?.retry_delay_minutes ?? dialingSettings?.retry_delay_minutes ?? 60;
  const leadCooldownMinutes = campaign?.lead_cooldown_minutes ?? dialingSettings?.lead_cooldown_minutes ?? 0;

  const now = new Date();
  const endedReason = call.ended_reason ?? '';
  const isRetryable = retryOn.includes(endedReason);

  let update: Record<string, unknown>;
  if (nextStatus === 'transferred') {
    update = { status: 'completed', final_disposition: 'transferred' };
  } else if (nextStatus === 'dnc') {
    update = { status: 'dnc', final_disposition: 'dnc' };
  } else if (nextStatus === 'cancelled') {
    update = { status: 'skipped', final_disposition: 'cancelled' };
  } else if ((nextStatus === 'failed' || nextStatus === 'transfer_failed') && isRetryable && campaignLead.attempt_count < maxAttempts) {
    update = { status: 'retry_pending', final_disposition: endedReason || nextStatus, next_eligible_at: computeNextEligibleAt(now, retryDelayMinutes, leadCooldownMinutes).toISOString() };
  } else if (nextStatus === 'failed' || nextStatus === 'transfer_failed') {
    update = { status: 'failed', final_disposition: endedReason || nextStatus };
  } else if (isRetryable && campaignLead.attempt_count < maxAttempts) {
    // completed, but the ended_reason is one this campaign treats as
    // "didn't actually connect" (e.g. no-answer surfaced as a completed
    // call by the engine) - still retryable.
    update = { status: 'retry_pending', final_disposition: endedReason || 'completed', next_eligible_at: computeNextEligibleAt(now, retryDelayMinutes, leadCooldownMinutes).toISOString() };
  } else {
    update = { status: 'completed', final_disposition: endedReason || 'completed' };
  }

  await supabase.from('campaign_leads').update(update).eq('id', campaignLead.id);
}
