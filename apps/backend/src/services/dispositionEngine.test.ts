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

  it('assigns DISCONNECTED for an early/immediate hangup with no meaningful interaction', () => {
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: 'no-answer' })).code).toBe('DISCONNECTED');
    expect(decideDisposition(signals({ status: 'failed', durationSeconds: 0, endedReason: 'pipeline-error' })).code).toBe('DISCONNECTED');
    expect(decideDisposition(signals({ status: 'completed', durationSeconds: 0, endedReason: null })).code).toBe('DISCONNECTED');
  });

  it('assigns HUNG_UP when the caller explicitly ended the call mid-conversation (short but real connection)', () => {
    const decision = decideDisposition(signals({ status: 'completed', durationSeconds: 3, endedReason: 'customer-ended-call' }));
    expect(decision.code).toBe('HUNG_UP');
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
