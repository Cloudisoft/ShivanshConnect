/**
 * Phase 15 load test: resolves an in-flight (`dialing`) call to a terminal
 * outcome by calling the REAL call-state-machine executor
 * (lib/callStateMachine.ts's `transitionCallState()`) directly - the exact
 * same function every Vapi/pipecat webhook handler calls
 * (routes/webhooks.ts). This is a deliberate scope choice: webhook
 * idempotency/duplicate/out-of-order delivery handling is exercised
 * through the real HTTP route in
 * failureRecovery.loadtest.test.ts/webhookIdempotencyAggregate section
 * (aggregating Phase 6/8's already-proven behavior, per the Phase 15
 * brief) - calling transitionCallState directly here for the FULL 10k-lead
 * drain keeps the throughput measurement about the dispatch pipeline
 * itself rather than re-measuring HTTP/webhook-ledger overhead 30,000+
 * times, while still exercising the real state machine, the real terminal
 * handler (services/callTerminalHandler.ts), the real disposition engine
 * and the real campaign_leads retry/disposition bookkeeping end to end.
 */
import { transitionCallState } from '../lib/callStateMachine.js';
import type { PgSupabaseAdapter } from './pgSupabaseAdapter.js';

export type SimulatedOutcome = 'connected' | 'no_answer';

/** Deterministic per-lead outcome bucket, derived from the seed index
 * embedded in the load-test lead's own `customer_number` (see seed.ts) so
 * the SAME lead always falls in the SAME bucket across every attempt:
 *   - ~1 in 12 leads (`seedIndex % 12 === 0`): PERMANENTLY no-answer - every
 *     attempt fails, so it correctly exhausts `max_attempts` and lands
 *     'failed' rather than retrying forever.
 *   - ~1 in 12 leads (`seedIndex % 12 === 6`): TRANSIENTLY no-answer - fails
 *     its first attempt (exercising the real retry_pending re-entry and
 *     re-dispatch path) but connects on any later attempt, so it
 *     eventually lands 'completed' - proving a retried lead can actually
 *     succeed, not just eventually give up.
 *   - everyone else: connects on the first attempt.
 * ~1/6 of leads see at least one no-answer outcome overall, a realistic
 * enough no-answer rate to exercise a meaningful volume of retries without
 * dominating the run. */
export function outcomeForAttempt(phoneNumber: string, attemptCount: number): SimulatedOutcome {
  const digits = phoneNumber.replace(/\D/g, '');
  const seedIndex = Number.parseInt(digits.slice(-5), 10) || 0;
  const bucket = seedIndex % 12;
  if (bucket === 0) return 'no_answer';
  if (bucket === 6 && attemptCount <= 1) return 'no_answer';
  return 'connected';
}

/** Drives ONE in-flight call (currently `dialing`) to its terminal status
 * through the real state machine, exactly mirroring the sequence
 * routes/webhooks.ts's vapi receiver applies for 'status-update' (in-
 * progress) then 'end-of-call-report' (ended). `attemptCount` is the
 * campaign_leads row's own attempt_count as of this claim (1 on a lead's
 * first ever attempt) - see outcomeForAttempt(). Returns the outcome
 * applied so the caller can tally expectations. */
export async function resolveCallToOutcome(adapter: PgSupabaseAdapter, callId: string, customerNumber: string, attemptCount: number): Promise<SimulatedOutcome> {
  const supabase = adapter.supabase;
  const outcome = outcomeForAttempt(customerNumber, attemptCount);
  if (outcome === 'connected') {
    await transitionCallState(supabase as any, callId, 'in_progress', { answered_at: new Date().toISOString() });
    await transitionCallState(supabase as any, callId, 'completed', {
      ended_at: new Date().toISOString(),
      ended_reason: 'customer-ended-call',
      duration_seconds: 45,
      cost: 0.12,
    });
  } else {
    await transitionCallState(supabase as any, callId, 'failed', {
      ended_at: new Date().toISOString(),
      ended_reason: 'no-answer',
      duration_seconds: 0,
    });
  }
  return outcome;
}
