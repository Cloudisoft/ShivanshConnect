/**
 * Phase 8: DNC recognition during a live call (master spec section 60).
 *
 * Wired from the tool-call/function-call webhook handler
 * (services/toolCallHandler.ts) when the orchestration layer signals the
 * caller asked not to be called again. Reuses Phase 2's existing DNC
 * infrastructure end to end - never a new parallel DNC system:
 *   1. Insert a real `dnc_entries` row (org-scoped).
 *   2. Flag the matching lead's `is_dnc = true` (existing Phase 2 helper).
 *   3. Transition the call to 'dnc' via the real state machine, which in
 *      turn (via lib/callStateMachine.ts's terminal handler) runs the
 *      disposition engine (assigns DNC) and campaign_leads bookkeeping
 *      (marks the lead 'dnc', never eligible for retry - retryEngine's
 *      hard DNC-never-retry rule covers it from here on regardless of any
 *      later manual re-add to a campaign).
 */
import { transitionCallState } from '../lib/callStateMachine.js';
import { flagExistingLeadsAsDnc } from '../lib/leadHelpers.js';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface HandleDncRequestResult {
  dncEntryId: string | null;
  leadFlagged: boolean;
  transitionApplied: boolean;
}

export async function handleDncRequest(
  supabase: Supabase,
  call: Record<string, any>,
  reason: string | null,
): Promise<HandleDncRequestResult> {
  const phone = call.customer_number as string;
  const orgId = call.organization_id as string;

  await supabase.from('call_events').insert({
    call_id: call.id,
    organization_id: orgId,
    event_type: 'call.dnc_requested',
    payload: { phone, reason: reason ?? null },
  });

  let dncEntryId: string | null = null;
  const { data: existingEntry } = await supabase
    .from('dnc_entries')
    .select('id')
    .eq('organization_id', orgId)
    .eq('phone_normalized', phone)
    .maybeSingle();
  if (existingEntry) {
    dncEntryId = existingEntry.id;
  } else {
    const { data: inserted, error } = await supabase
      .from('dnc_entries')
      .insert({ organization_id: orgId, phone_normalized: phone, reason: reason ?? 'Caller requested during a call.', source: 'caller_request' })
      .select('id')
      .single();
    if (error) throw error;
    dncEntryId = inserted.id;
  }

  const flaggedCount = await flagExistingLeadsAsDnc(supabase as any, orgId, phone, reason ?? 'Caller requested to be placed on the Do Not Call list during a call.');

  const result = await transitionCallState(supabase, call.id, 'dnc', { ended_reason: 'caller_requested_dnc', ended_at: new Date().toISOString() });

  return { dncEntryId, leadFlagged: flaggedCount > 0, transitionApplied: result.applied };
}
