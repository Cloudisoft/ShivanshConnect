/**
 * Phase 8: the call state machine's terminal-transition handler.
 *
 * Wires together, in the fixed order the spec requires:
 *   1. the deterministic disposition engine (assigns exactly one
 *      call_dispositions row for this call - skipped for 'cancelled',
 *      which never actually took place), then
 *   2. the campaign_leads update that consumes that assigned disposition
 *      (services/campaignLeadDisposition.ts) as its single source of
 *      truth, applying services/retryEngine.ts's decision.
 *
 * Registered once with lib/callStateMachine.ts's
 * `registerTerminalCallHandler()` at process startup (apps/backend/src/
 * index.ts) so every `transitionCallState()` call that lands on a
 * terminal status runs this automatically - never manually invoked by the
 * UI.
 */
import type { CallTransitionEvent } from '../lib/callStateMachine.js';
import { isTerminalCallStatus } from '../lib/callStateMachine.js';
import { assignDispositionForCall } from './dispositionEngine.js';
import { applyCallOutcomeToCampaignLead } from './campaignLeadDisposition.js';
import { processCallArtifacts } from './processCallArtifacts.js';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export async function handleTerminalCall(supabase: Supabase, event: CallTransitionEvent): Promise<void> {
  if (!isTerminalCallStatus(event.to)) return;

  let dispositionCode: string | null = null;
  if (event.to !== 'cancelled') {
    const result = await assignDispositionForCall(supabase, event.call);
    dispositionCode = result.code;
  }

  await applyCallOutcomeToCampaignLead(
    supabase,
    {
      id: event.callId,
      organization_id: event.organizationId,
      campaign_id: event.call.campaign_id ?? null,
      lead_id: event.call.lead_id ?? null,
      ended_reason: (event.context.ended_reason as string | null | undefined) ?? event.call.ended_reason ?? null,
    },
    event.to,
    dispositionCode,
  );

  // Phase 9: real transcript/recording ingestion + AI summary generation
  // (spec sections 21/22/23-partial). Deliberately NOT awaited here - it
  // involves real outbound HTTP calls to the orchestration engine and to
  // this call's provider recording URL, which must never make the webhook
  // handler (or a test) that triggered this terminal transition wait on
  // them. 'cancelled' is excluded, same as the disposition engine above -
  // a cancelled call never actually took place, so there is nothing to
  // fetch. setImmediate is the same fire-and-forget-but-scheduled pattern
  // every prior phase's async ingestion (importLeads.ts, processKnowledge
  // Document.ts) already uses.
  if (event.to !== 'cancelled') {
    setImmediate(() => {
      processCallArtifacts(event.callId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('processCallArtifacts failed for call', event.callId, err);
      });
    });
  }
}
