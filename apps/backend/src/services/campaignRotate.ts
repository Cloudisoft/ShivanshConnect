/**
 * Phase 7: lead list rotation/reuse (explicit user requirement, spec
 * section 11's disposition model). Re-running a campaign against a
 * previously-worked lead list must filter OUT leads whose last outcome
 * was a genuine terminal result (disconnected/not-interested/hung-up/DNC/
 * transferred/completed) and only re-queue leads that are still eligible
 * for another attempt (no-answer/busy/failed/voicemail, or a lead that
 * never got attempted at all).
 *
 * Kept as a pure function over already-fetched campaign_leads rows so the
 * exact inclusion/exclusion rule is directly unit-testable without a DB.
 */

import type { CampaignLead } from '@shivanshconnect/shared';

export interface RotateDecision {
  leadId: string;
  campaignLeadId: string;
  include: boolean;
  reason: string;
}

/**
 * A campaign_leads row is excluded from rotation when its current STATUS
 * indicates a genuine terminal outcome that should never be re-dialed.
 * `dnc` is included here even though DNC leads are also excluded at
 * dispatch-eligibility time - excluding them from rotation too means the
 * rotate preview never even offers to re-queue them.
 *
 * Phase 8 note: this used to also pattern-match `final_disposition`'s raw
 * ended_reason string against a fixed keyword list
 * (ROTATE_EXCLUDED_DISPOSITIONS). That is now redundant AND unsafe:
 * services/campaignLeadDisposition.ts (the Phase 8 single source of
 * truth) already sets `status` correctly for every outcome - including a
 * retry-pending lead whose disposition CODE happens to read "DISCONNECTED"
 * or "HUNG_UP" while it is still fully eligible for another automatic
 * attempt. Trusting `status` alone (not a coincidental substring match on
 * the disposition string) is what keeps rotation and the dispatcher's own
 * eligibility check agreeing with each other. */
function isPermanentOutcome(campaignLead: Pick<CampaignLead, 'status'>): boolean {
  return campaignLead.status === 'dnc' || campaignLead.status === 'completed';
}

/** Leads eligible for re-queue: never attempted (`pending`), or a
 * retryable outcome (`retry_pending`, `failed`, or `skipped` from a prior
 * run where a calling-window/eligibility skip - not a genuine
 * disposition - was the reason). */
function isRetryableOutcome(campaignLead: Pick<CampaignLead, 'status' | 'final_disposition'>): boolean {
  if (isPermanentOutcome(campaignLead)) return false;
  return ['pending', 'retry_pending', 'failed', 'skipped'].includes(campaignLead.status);
}

export function decideRotation(
  campaignLeads: Pick<CampaignLead, 'id' | 'lead_id' | 'status' | 'final_disposition'>[],
): RotateDecision[] {
  return campaignLeads.map((cl) => {
    if (isPermanentOutcome(cl)) {
      return {
        leadId: cl.lead_id,
        campaignLeadId: cl.id,
        include: false,
        reason: `Excluded - last outcome was "${cl.final_disposition ?? cl.status}" (permanent).`,
      };
    }
    if (isRetryableOutcome(cl)) {
      return {
        leadId: cl.lead_id,
        campaignLeadId: cl.id,
        include: true,
        reason: cl.status === 'pending' ? 'Never attempted - included.' : `Retryable outcome ("${cl.final_disposition ?? cl.status}") - included.`,
      };
    }
    // In-flight statuses (dialing/ringing/connected/in_progress/
    // transferring) are neither permanent nor safely retryable right now
    // - never rotate a lead currently mid-call.
    return { leadId: cl.lead_id, campaignLeadId: cl.id, include: false, reason: `Excluded - currently in progress ("${cl.status}").` };
  });
}
