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
 *   4. Actually end the live call with the provider - recognizing the
 *      request only ever updated our own local state, the AI would keep
 *      right on talking (and the caller stays on a call they explicitly
 *      asked to end) until it wrapped up the conversation naturally on
 *      its own. A caller who says "stop calling me" should be hung up on
 *      immediately, not talked at for another turn or two.
 */
import { transitionCallState } from '../lib/callStateMachine.js';
import { flagExistingLeadsAsDnc } from '../lib/leadHelpers.js';
import { resolveProviderForCall } from '../lib/orchestration/resolveProvider.js';
import { OrchestrationProviderError } from '../lib/orchestration/types.js';
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

  const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
  if (providerCallId) {
    try {
      const provider = await resolveProviderForCall(supabase, call);
      await provider.endCall(providerCallId);
    } catch (err) {
      // The DNC record/disposition above already committed regardless -
      // a provider hangup failure (already ended, transient network
      // error, etc.) must never undo that. Log and move on; a call the
      // provider already considers over is a harmless no-op here too.
      if (!(err instanceof OrchestrationProviderError)) throw err;
    }
  }

  return { dncEntryId, leadFlagged: flaggedCount > 0, transitionApplied: result.applied };
}
