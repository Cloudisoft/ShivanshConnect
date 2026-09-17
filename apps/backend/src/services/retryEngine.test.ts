import { describe, expect, it } from 'vitest';
import { decideRetry, isDncNeverRetry, type RetryDecisionInput } from './retryEngine.js';

function input(overrides: Partial<RetryDecisionInput>): RetryDecisionInput {
  return {
    dispositionCode: 'DISCONNECTED',
    isDnc: false,
    endedReason: null,
    attemptCount: 1,
    maxAttempts: 3,
    retryDelayMinutes: 60,
    leadCooldownMinutes: 0,
    now: new Date('2026-01-01T12:00:00Z'),
    ...overrides,
  };
}

describe('retryEngine - named rules', () => {
  it('HARD RULE: a DNC lead never retries, even under adversarial input that tries to force it', () => {
    // Adversarial: everything else says "retry me" (no-answer, attempts
    // far below max, a generous retryOnOverride, a non-DNC disposition
    // code) - isDnc alone must still block it.
    const decision = decideRetry(
      input({
        isDnc: true,
        dispositionCode: 'CALL_CONNECTED',
        endedReason: 'no-answer',
        attemptCount: 0,
        maxAttempts: 100,
        retryOnOverride: ['no-answer', 'busy', 'dnc', 'anything'],
      }),
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.rule).toBe('dnc_never_retry');
    expect(decision.nextEligibleAt).toBeNull();
  });

  it('HARD RULE: a disposition of DNC never retries even if isDnc is somehow false', () => {
    const decision = decideRetry(input({ isDnc: false, dispositionCode: 'DNC', endedReason: 'no-answer', attemptCount: 0, maxAttempts: 100 }));
    expect(decision.shouldRetry).toBe(false);
    expect(decision.rule).toBe('dnc_never_retry');
  });

  it('isDncNeverRetry is true whenever either signal is set, and only then', () => {
    expect(isDncNeverRetry({ isDnc: true, dispositionCode: 'CALL_CONNECTED' })).toBe(true);
    expect(isDncNeverRetry({ isDnc: false, dispositionCode: 'DNC' })).toBe(true);
    expect(isDncNeverRetry({ isDnc: false, dispositionCode: 'CALL_CONNECTED' })).toBe(false);
  });

  it('no-answer retries (within max attempts) with a future next_eligible_at', () => {
    const decision = decideRetry(input({ dispositionCode: 'DISCONNECTED', endedReason: 'no-answer' }));
    expect(decision.shouldRetry).toBe(true);
    expect(decision.rule).toBe('no_answer_retry');
    expect(new Date(decision.nextEligibleAt!).getTime()).toBeGreaterThan(input({}).now.getTime());
  });

  it('busy retries', () => {
    const decision = decideRetry(input({ endedReason: 'busy' }));
    expect(decision.shouldRetry).toBe(true);
    expect(decision.rule).toBe('busy_retry');
  });

  it('a temporary provider failure retries', () => {
    const decision = decideRetry(input({ endedReason: 'twilio-failed' }));
    expect(decision.shouldRetry).toBe(true);
    expect(decision.rule).toBe('temporary_failure_retry');
  });

  it('a successful transfer never auto-retries', () => {
    const decision = decideRetry(input({ dispositionCode: 'TRANSFERRED', endedReason: 'assistant-forwarded-call' }));
    expect(decision.shouldRetry).toBe(false);
    expect(decision.rule).toBe('transfer_success_no_retry');
  });

  it('max attempts already reached blocks retry regardless of ended_reason', () => {
    const decision = decideRetry(input({ endedReason: 'no-answer', attemptCount: 3, maxAttempts: 3 }));
    expect(decision.shouldRetry).toBe(false);
    expect(decision.rule).toBe('max_attempts_reached');
  });

  it('a connected completed call follows campaign rules (manual rotation), never auto-retried', () => {
    const decision = decideRetry(input({ dispositionCode: 'CALL_CONNECTED', endedReason: 'customer-ended-call' }));
    expect(decision.shouldRetry).toBe(false);
    expect(decision.rule).toBe('completed_follows_campaign_rules');
  });

  it('an unrecognized, non-retryable ended_reason does not retry', () => {
    const decision = decideRetry(input({ endedReason: 'some-unrecognized-reason' }));
    expect(decision.shouldRetry).toBe(false);
    expect(decision.rule).toBe('not_retryable_ended_reason');
  });

  it('a campaign-level retryOnOverride can widen which ended_reason values retry, but never for DNC', () => {
    const decision = decideRetry(input({ endedReason: 'custom-carrier-error', retryOnOverride: ['custom-carrier-error'] }));
    expect(decision.shouldRetry).toBe(true);
    const dncBlocked = decideRetry(input({ isDnc: true, endedReason: 'custom-carrier-error', retryOnOverride: ['custom-carrier-error'] }));
    expect(dncBlocked.shouldRetry).toBe(false);
  });

  it('always computes next_eligible_at respecting both retryDelayMinutes and leadCooldownMinutes (the longer one wins)', () => {
    const decision = decideRetry(input({ endedReason: 'busy', retryDelayMinutes: 10, leadCooldownMinutes: 120 }));
    const delayMs = new Date(decision.nextEligibleAt!).getTime() - input({}).now.getTime();
    expect(delayMs).toBe(120 * 60_000);
  });
});
