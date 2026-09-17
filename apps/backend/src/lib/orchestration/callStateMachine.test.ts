import { describe, expect, it } from 'vitest';
import { isTerminalCallStatus, isValidCallTransition } from './callStateMachine.js';

describe('call state machine', () => {
  it('allows the normal outbound happy path', () => {
    expect(isValidCallTransition('queued', 'dialing')).toBe(true);
    expect(isValidCallTransition('dialing', 'ringing')).toBe(true);
    expect(isValidCallTransition('ringing', 'answered')).toBe(true);
    expect(isValidCallTransition('answered', 'in_progress')).toBe(true);
    expect(isValidCallTransition('in_progress', 'completed')).toBe(true);
  });

  it('allows the transfer sub-flow and recovery from a failed transfer', () => {
    expect(isValidCallTransition('in_progress', 'transfer_pending')).toBe(true);
    expect(isValidCallTransition('transfer_pending', 'transferring')).toBe(true);
    expect(isValidCallTransition('transferring', 'transferred')).toBe(true);
    expect(isValidCallTransition('transferring', 'transfer_failed')).toBe(true);
    expect(isValidCallTransition('transfer_failed', 'in_progress')).toBe(true);
  });

  it('rejects an invalid/out-of-order transition (e.g. queued straight to completed)', () => {
    expect(isValidCallTransition('queued', 'completed')).toBe(false);
    expect(isValidCallTransition('completed', 'in_progress')).toBe(false);
    expect(isValidCallTransition('transferred', 'in_progress')).toBe(false);
  });

  it('treats a repeated identical status as a valid no-op transition (idempotent redelivery)', () => {
    expect(isValidCallTransition('in_progress', 'in_progress')).toBe(true);
    expect(isValidCallTransition('completed', 'completed')).toBe(true);
  });

  it('terminal statuses have no outbound transitions except to themselves', () => {
    for (const status of ['completed', 'failed', 'dnc', 'cancelled', 'transferred'] as const) {
      expect(isTerminalCallStatus(status)).toBe(true);
      expect(isValidCallTransition(status, 'in_progress')).toBe(false);
    }
  });
});
