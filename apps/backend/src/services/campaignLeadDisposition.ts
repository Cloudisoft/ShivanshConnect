/**
 * Phase 7/8: hooks a call's assigned disposition (services/
 * dispositionEngine.ts) and retry decision (services/retryEngine.ts) into
 * campaign_leads. Called from services/callTerminalHandler.ts right after
 * a call's status is actually transitioned to a terminal state and a
 * disposition has been assigned - this is the ONLY place campaign_leads.
 * final_disposition/status/next_eligible_at are written, so there is a
 * single source of truth between `call_dispositions` and
 * `campaign_leads.final_disposition` (never two divergent derivations of
 * "what happened on this call").
 */
import type { getSupabaseAdmin } from '../lib/supabase.js';
import { decideRetry } from './retryEngine.js';
import type { CampaignDispositionRulesSnapshot, CallStatus, SystemDispositionCode } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export const TERMINAL_CALL_STATUSES: CallStatus[] = ['completed', 'failed', 'transferred', 'dnc', 'cancelled', 'transfer_failed'];

export interface ApplyDispositionInput {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  lead_id: string | null;
  ended_reason: string | null;
}

/**
 * Applies the outcome of ONE call (identified by its already-assigned
 * disposition code) to the corresponding campaign_leads row, using
 * retryEngine.decideRetry() as the single source of truth for whether an
 * automatic retry is scheduled. Never re-derives its own ad-hoc
 * disposition logic - `dispositionCode` is exactly what
 * services/dispositionEngine.ts (or a manual override) already assigned.
 */
export async function applyCallOutcomeToCampaignLead(
  supabase: Supabase,
  call: ApplyDispositionInput,
  nextStatus: CallStatus,
  dispositionCode: SystemDispositionCode | string | null,
): Promise<void> {
  if (!call.campaign_id || !call.lead_id) return;
  if (!TERMINAL_CALL_STATUSES.includes(nextStatus)) return;
  // A cancelled call never actually took place (e.g. the campaign was
  // stopped before dialing) - no disposition is assigned for it (see
  // callTerminalHandler.ts) and no campaign_leads bookkeeping is needed
  // beyond marking it skipped, handled by the dispatcher itself.
  if (nextStatus === 'cancelled') return;

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

  const { data: lead } = await supabase.from('leads').select('is_dnc').eq('id', call.lead_id).maybeSingle();
  const { data: campaign } = await supabase.from('campaigns').select('id, current_version_id, lead_cooldown_minutes').eq('id', call.campaign_id).maybeSingle();
  const { data: dialingSettings } = await supabase.from('dialing_settings').select('*').eq('organization_id', call.organization_id).eq('is_default', true).maybeSingle();

  let dispositionRules: CampaignDispositionRulesSnapshot | null = null;
  if (campaign?.current_version_id) {
    const { data: version } = await supabase.from('campaign_versions').select('disposition_rules').eq('id', campaign.current_version_id).maybeSingle();
    dispositionRules = (version?.disposition_rules as CampaignDispositionRulesSnapshot) ?? null;
  }
  const maxAttempts = dispositionRules?.max_attempts ?? dialingSettings?.max_attempts ?? 3;
  const retryDelayMinutes = dispositionRules?.retry_delay_minutes ?? dialingSettings?.retry_delay_minutes ?? 60;
  const leadCooldownMinutes = campaign?.lead_cooldown_minutes ?? dialingSettings?.lead_cooldown_minutes ?? 0;

  // nextStatus === 'dnc' is also caught by dispositionCode === 'DNC' in
  // practice (the disposition engine always assigns DNC for a call that
  // ended in the 'dnc' state), but check both explicitly - a lead's own
  // is_dnc flag is the ultimate hard signal, independent of how this
  // particular call's disposition was derived.
  const isDnc = Boolean(lead?.is_dnc) || nextStatus === 'dnc' || dispositionCode === 'DNC';

  if (isDnc) {
    await supabase.from('campaign_leads').update({ status: 'dnc', final_disposition: dispositionCode ?? 'DNC', next_eligible_at: null }).eq('id', campaignLead.id);
    return;
  }

  const retryDecision = decideRetry({
    dispositionCode,
    isDnc,
    endedReason: call.ended_reason,
    attemptCount: campaignLead.attempt_count,
    maxAttempts,
    retryOnOverride: dispositionRules?.retry_on ?? null,
    retryDelayMinutes,
    leadCooldownMinutes,
    now: new Date(),
  });

  let update: Record<string, unknown>;
  if (retryDecision.shouldRetry) {
    update = { status: 'retry_pending', final_disposition: dispositionCode ?? call.ended_reason ?? nextStatus, next_eligible_at: retryDecision.nextEligibleAt };
  } else if (dispositionCode === 'TRANSFERRED') {
    update = { status: 'completed', final_disposition: dispositionCode };
  } else if (nextStatus === 'failed' || nextStatus === 'transfer_failed') {
    update = { status: 'failed', final_disposition: dispositionCode ?? call.ended_reason ?? nextStatus };
  } else {
    update = { status: 'completed', final_disposition: dispositionCode ?? call.ended_reason ?? nextStatus };
  }

  await supabase.from('campaign_leads').update(update).eq('id', campaignLead.id);
}
