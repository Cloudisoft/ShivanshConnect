/**
 * Phase 8: retry engine formalization (master spec section 52).
 *
 * Phase 7's `leadEligibility.computeNextEligibleAt()` already implements
 * the actual cooldown/delay math; this module is the explicit, NAMED rule
 * table on top of it that decides WHETHER a lead should be retried at all,
 * given the disposition the engine (or a manual override) just assigned.
 * Every rule is a small, independently testable function; `decideRetry()`
 * applies them in a fixed order with one hard, unconditional invariant
 * checked first: DNC NEVER retries, full stop, even under adversarial
 * input (a caller that explicitly tries to force-retry a DNC lead is
 * rejected - see retryEngine.test.ts).
 */
import type { SystemDispositionCode } from '@shivanshconnect/shared';
import { computeNextEligibleAt } from './leadEligibility.js';

export type RetryRuleName =
  | 'dnc_never_retry'
  | 'transfer_success_no_retry'
  | 'max_attempts_reached'
  | 'no_answer_retry'
  | 'busy_retry'
  | 'temporary_failure_retry'
  | 'not_retryable_ended_reason'
  | 'completed_follows_campaign_rules';

export interface RetryDecision {
  shouldRetry: boolean;
  rule: RetryRuleName;
  nextEligibleAt: string | null;
  reason: string;
}

const NO_ANSWER_ENDED_REASONS = new Set(['no-answer', 'customer-did-not-answer']);
const BUSY_ENDED_REASONS = new Set(['busy']);
const TEMPORARY_FAILURE_ENDED_REASONS = new Set(['twilio-failed', 'pipeline-error', 'assistant-error', 'dial-failed']);

export interface RetryDecisionInput {
  /** The disposition code just assigned to this call (engine or manual) -
   * the DNC hard rule keys off THIS, not the raw ended_reason, so a
   * disposition of DNC always blocks a retry regardless of what
   * ended_reason string happens to be attached. */
  dispositionCode: SystemDispositionCode | string | null;
  /** Independent DNC signal (leads.is_dnc / campaign_leads already marked
   * dnc) - checked in addition to dispositionCode so the hard rule holds
   * even if a disposition somehow wasn't DNC but the lead itself is. */
  isDnc: boolean;
  endedReason: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** Per-campaign override of which ended_reason values are retryable
   * (campaign_versions.disposition_rules.retry_on) - defaults to the
   * three named-rule reason sets above when not provided. */
  retryOnOverride?: string[] | null;
  retryDelayMinutes: number;
  leadCooldownMinutes: number;
  now: Date;
}

/** The hard, unconditional invariant: a DNC lead is NEVER retried, no
 * matter what other flags are set on the input. Called first and alone -
 * nothing downstream can override it. */
export function isDncNeverRetry(input: Pick<RetryDecisionInput, 'dispositionCode' | 'isDnc'>): boolean {
  return input.isDnc || input.dispositionCode === 'DNC';
}

/**
 * Applies the named rules in a fixed order and returns exactly one
 * decision. `retryOnOverride`, when given, is honored for the
 * no-answer/busy/temporary-failure classification but can NEVER make a DNC
 * lead retryable - that check runs first and unconditionally.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  // Rule 1 (hard, unconditional): DNC never retries.
  if (isDncNeverRetry(input)) {
    return { shouldRetry: false, rule: 'dnc_never_retry', nextEligibleAt: null, reason: 'Lead is on the Do Not Call list - automatic retry is never permitted, regardless of any other setting.' };
  }

  // Rule 2: a successfully transferred call is never auto-retried.
  if (input.dispositionCode === 'TRANSFERRED') {
    return { shouldRetry: false, rule: 'transfer_success_no_retry', nextEligibleAt: null, reason: 'Call was successfully transferred - no automatic retry.' };
  }

  // Rule 3: attempts already exhausted.
  if (input.attemptCount >= input.maxAttempts) {
    return { shouldRetry: false, rule: 'max_attempts_reached', nextEligibleAt: null, reason: `Maximum attempts (${input.maxAttempts}) already reached.` };
  }

  const reason = input.endedReason ?? '';
  const overrideSet = input.retryOnOverride ? new Set(input.retryOnOverride) : null;

  const isNoAnswer = overrideSet ? overrideSet.has(reason) && NO_ANSWER_ENDED_REASONS.has(reason) : NO_ANSWER_ENDED_REASONS.has(reason);
  const isBusy = overrideSet ? overrideSet.has(reason) && BUSY_ENDED_REASONS.has(reason) : BUSY_ENDED_REASONS.has(reason);
  const isTemporaryFailure = overrideSet ? overrideSet.has(reason) && TEMPORARY_FAILURE_ENDED_REASONS.has(reason) : TEMPORARY_FAILURE_ENDED_REASONS.has(reason);
  // A campaign-level override may ALSO list reasons this module doesn't
  // itself categorize (a custom ended_reason string) - honor it as a
  // generic retryable reason, still subject to every rule above/below.
  const isOverrideRetryable = overrideSet ? overrideSet.has(reason) : false;

  if (isNoAnswer) {
    return { shouldRetry: true, rule: 'no_answer_retry', nextEligibleAt: computeNextEligibleAt(input.now, input.retryDelayMinutes, input.leadCooldownMinutes).toISOString(), reason: 'No answer - eligible for automatic retry.' };
  }
  if (isBusy) {
    return { shouldRetry: true, rule: 'busy_retry', nextEligibleAt: computeNextEligibleAt(input.now, input.retryDelayMinutes, input.leadCooldownMinutes).toISOString(), reason: 'Line was busy - eligible for automatic retry.' };
  }
  if (isTemporaryFailure) {
    return { shouldRetry: true, rule: 'temporary_failure_retry', nextEligibleAt: computeNextEligibleAt(input.now, input.retryDelayMinutes, input.leadCooldownMinutes).toISOString(), reason: 'Temporary provider failure - eligible for automatic retry.' };
  }
  if (isOverrideRetryable) {
    return { shouldRetry: true, rule: 'temporary_failure_retry', nextEligibleAt: computeNextEligibleAt(input.now, input.retryDelayMinutes, input.leadCooldownMinutes).toISOString(), reason: `Ended reason "${reason}" is configured as retryable for this campaign.` };
  }

  if (input.dispositionCode === 'CALL_CONNECTED') {
    // Completed, connected call: some orgs re-attempt "Not Interested"
    // leads later, but only via Phase 7's manual rotation flow - never
    // automatically re-queued here.
    return { shouldRetry: false, rule: 'completed_follows_campaign_rules', nextEligibleAt: null, reason: 'Call connected - follow-up is via manual list rotation, not automatic retry.' };
  }

  return { shouldRetry: false, rule: 'not_retryable_ended_reason', nextEligibleAt: null, reason: reason ? `Ended reason "${reason}" is not configured as retryable.` : 'No retryable signal present.' };
}
