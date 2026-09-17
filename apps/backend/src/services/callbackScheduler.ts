/**
 * Phase 8: the callback scheduler (master spec sections 17, 53).
 *
 * `createCallback()` is the ONE creation path - used by both the manual
 * `POST /api/v1/callbacks` route and the AI tool-call webhook handler
 * (services/toolCallHandler.ts) - so a human-created and an AI-created
 * callback are indistinguishable in every downstream system.
 *
 * Callback scheduling overrides normal cooldown (spec 53) by writing the
 * callback's `scheduled_at` directly onto the corresponding
 * `campaign_leads.next_eligible_at` and resetting its status back to
 * `pending` (never a new/parallel column or a separate dispatch path) -
 * the exact same eligibility query and CAS claim Phase 7's dispatcher
 * already proved race-safe then picks the lead up automatically once
 * `scheduled_at` arrives. A DNC lead's campaign_leads row is deliberately
 * left untouched - the same lead can never be resurrected into dialing by
 * a callback (see dncToolHandler.ts and campaigns.integration.test.ts for
 * the regression test on this exact invariant).
 */
import { ValidationError } from '../lib/errors.js';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface CreateCallbackInput {
  organizationId: string;
  leadId: string;
  campaignId?: string | null;
  phoneE164?: string | null;
  scheduledAt: string;
  timezone?: string;
  reason?: string | null;
  notes?: string | null;
  assignedTo?: string | null;
  sourceCallId?: string | null;
  createdBy?: string | null;
}

export interface CreateCallbackResult {
  callback: Record<string, any>;
  campaignLeadUpdated: boolean;
}

export async function createCallback(supabase: Supabase, input: CreateCallbackInput): Promise<CreateCallbackResult> {
  const { data: lead, error: leadError } = await supabase.from('leads').select('id, organization_id, phone_normalized, is_dnc').eq('id', input.leadId).maybeSingle();
  if (leadError) throw leadError;
  if (!lead || lead.organization_id !== input.organizationId) {
    throw new ValidationError('Lead not found for this organization.');
  }

  const scheduledDate = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) throw new ValidationError('scheduled_at must be a valid ISO 8601 timestamp.');
  if (scheduledDate.getTime() <= Date.now()) throw new ValidationError('scheduled_at must be in the future.');

  const phoneE164 = input.phoneE164 ?? lead.phone_normalized;

  const { data: callback, error } = await supabase
    .from('callbacks')
    .insert({
      organization_id: input.organizationId,
      campaign_id: input.campaignId ?? null,
      lead_id: input.leadId,
      phone_e164: phoneE164,
      scheduled_at: scheduledDate.toISOString(),
      timezone: input.timezone ?? 'America/New_York',
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      assigned_to: input.assignedTo ?? 'ai',
      status: 'scheduled',
      source_call_id: input.sourceCallId ?? null,
      created_by: input.createdBy ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;

  let campaignLeadUpdated = false;
  // Only an AI-assigned callback tied to a campaign flows through the
  // dispatcher's own dial queue - a callback assigned to a specific human
  // agent is that agent's manual call-back, never auto-dialed.
  if (input.campaignId && (input.assignedTo === undefined || input.assignedTo === 'ai')) {
    if (!lead.is_dnc) {
      const { data: campaignLead } = await supabase
        .from('campaign_leads')
        .select('id, status')
        .eq('campaign_id', input.campaignId)
        .eq('lead_id', input.leadId)
        .maybeSingle();
      if (campaignLead && campaignLead.status !== 'dnc' && !['dialing', 'ringing', 'connected', 'in_progress', 'transferring'].includes(campaignLead.status)) {
        await supabase
          .from('campaign_leads')
          .update({ status: 'pending', next_eligible_at: scheduledDate.toISOString() })
          .eq('id', campaignLead.id);
        campaignLeadUpdated = true;
      }
    }
  }

  return { callback, campaignLeadUpdated };
}
