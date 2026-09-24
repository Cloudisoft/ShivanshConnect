import { describe, expect, it } from 'vitest';
import { decideDisposition, type CallOutcomeSignals } from './dispositionEngine.js';

function signals(overrides: Partial<CallOutcomeSignals>): CallOutcomeSignals {
  return {
    status: 'completed',
    endedReason: null,
    durationSeconds: null,
    amdDetected: false,
    transferStatus: null,
    dncRequested: false,
    ...overrides,
  };
}

describe('dispositionEngine.decideDisposition - the deterministic rules engine', () => {
  it('DNC always wins, regardless of any other signal', () => {
    expect(decideDisposition(signals({ status: 'dnc' })).code).toBe('DNC');
    expect(decideDisposition(signals({ dncRequested: true, status: 'completed', durationSeconds: 120 })).code).toBe('DNC');
  });

  it('assigns VOICEMAIL when AMD detects voicemail (status or explicit AMD signal)', () => {
    expect(decideDisposition(signals({ status: 'voicemail' })).code).toBe('VOICEMAIL');
    expect(decideDisposition(signals({ status: 'completed', amdDetected: true })).code).toBe('VOICEMAIL');
  });

  it('assigns ANSWERING_MACHINE when the status is answering_machine', () => {
    expect(decideDisposition(signals({ status: 'answering_machine' })).code).toBe('ANSWERING_MACHINE');
  });

  it('assigns TRANSFERRED when the call status or transfer status is a success', () => {
    expect(decideDisposition(signals({ status: 'transferred' })).code).toBe('TRANSFERRED');
    expect(decideDisposition(signals({ status: 'completed', transferStatus: 'succeeded' })).code).toBe('TRANSFERRED');
  });

  it('assigns CALL_DISCONNECTED_IN_TRANSFER when a transfer failed / caller disconnected during transfer', () => {
    expect(decideDisposition(signals({ status: 'transfer_failed' })).code).toBe('CALL_DISCONNECTED_IN_TRANSFER');
    expect(decideDisposition(signals({ status: 'failed', transferStatus: 'failed' })).code).toBe('CALL_DISCONNECTED_IN_TRANSFER');
  });

  it('assigns CALL_CONNECTED when the human answered and a real conversation occurred', () => {
    const decision = decideDisposition(signals({ status: 'completed', durationSeconds: 45, endedReason: 'customer-ended-call' }));
    expect(decision.code).toBe('CALL_CONNECTED');
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it('does NOT assign CALL_CONNECTED for a short "completed" call with a no-interaction ended_reason', () => {
    const decision = decideDisposition(signals({ status: 'completed', durationSeconds: 2, endedReason: 'no-answer' }));
    expect(decision.code).not.toBe('CALL_CONNECTED');
  });

  it('assigns NO_ANSWER for a ring-no-pickup outcome - its own disposition, not DISCONNECTED', () => {
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: 'no-answer' })).code).toBe('NO_ANSWER');
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: 'customer-did-not-answer' })).code).toBe('NO_ANSWER');
  });

  it('assigns NOT_IN_SERVICE for an invalid/disconnected destination number - its own disposition, not DISCONNECTED', () => {
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: 'invalid-number' })).code).toBe('NOT_IN_SERVICE');
  });

  it('assigns DISCONNECTED only for an explicit technical-failure ended_reason (never no-answer/not-in-service, never a bare zero-duration default)', () => {
    expect(decideDisposition(signals({ status: 'failed', durationSeconds: 0, endedReason: 'pipeline-error' })).code).toBe('DISCONNECTED');
    expect(decideDisposition(signals({ status: 'failed', durationSeconds: 0, endedReason: 'busy' })).code).toBe('DISCONNECTED');
    // Bug fix: a zero-duration call with NO reason at all used to fall
    // back to DISCONNECTED by default - DISCONNECTED is never a default,
    // only an explicit technical signal (falls through to the generic
    // HUNG_UP fallback instead, same as any other unexplained short call).
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: null })).code).toBe('HUNG_UP');
  });

  it('assigns HUNG_UP - never DISCONNECTED - whenever the caller actively ended the call, no matter how short', () => {
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 3, endedReason: 'customer-ended-call' })).code).toBe('HUNG_UP');
    // Bug fix: the caller hanging up in the very first second (duration
    // 0) used to be misclassified as DISCONNECTED - a bare duration-0
    // check used to fire before the caller-hangup reason was ever
    // checked. A call the customer actively ended is a hang-up, full
    // stop, regardless of how briefly it lasted.
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: 'customer-ended-call' })).code).toBe('HUNG_UP');
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: 'caller-hung-up' })).code).toBe('HUNG_UP');
  });

  it('falls back to HUNG_UP for a short completed call with no other explicit signal', () => {
    const decision = decideDisposition(signals({ status: 'completed', durationSeconds: 4, endedReason: 'some-unrecognized-reason' }));
    expect(decision.code).toBe('HUNG_UP');
  });

  it('every decision includes a non-empty human-readable reason', () => {
    const decision = decideDisposition(signals({ status: 'completed', durationSeconds: 45 }));
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
