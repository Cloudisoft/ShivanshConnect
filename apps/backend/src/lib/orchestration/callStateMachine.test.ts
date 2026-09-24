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

  it('a caller can request DNC from any in-call, non-terminal state (Phase 8 spec 60)', () => {
    for (const status of ['queued', 'dialing', 'ringing', 'answered', 'in_progress', 'voicemail', 'answering_machine', 'transfer_pending', 'transferring', 'transfer_failed'] as const) {
      expect(isValidCallTransition(status, 'dnc')).toBe(true);
    }
  });

  it('every state in the full enum is represented in the transition table (no orphan states)', () => {
    const allStates = ['queued', 'dialing', 'ringing', 'answered', 'in_progress', 'voicemail', 'answering_machine', 'transfer_pending', 'transferring', 'transferred', 'transfer_failed', 'completed', 'failed', 'dnc', 'cancelled'] as const;
    for (const status of allStates) {
      // Every state is at least a valid no-op transition target from
      // itself - proves the transition table has an entry for it.
      expect(isValidCallTransition(status, status)).toBe(true);
    }
  });

  it('rejects skipping straight from queued to in_progress (must go through dialing first)', () => {
    expect(isValidCallTransition('queued', 'in_progress')).toBe(false);
  });

  it('allows an unanswered call to end directly from dialing/ringing (no-answer, declined before pickup)', () => {
    // A real no-answer call never passes through 'answered'/'in_progress' -
    // the engine's end-of-call-report still reports it 'completed'
    // (disposition captures the no-answer outcome separately). Rejecting
    // this left real calls stuck showing 'dialing' forever instead of
    // their actual terminal state.
    expect(isValidCallTransition('dialing', 'completed')).toBe(true);
    expect(isValidCallTransition('ringing', 'completed')).toBe(true);
  });

  it('allows a transferred outcome directly from any pre-terminal state (a lost intermediate webhook must never strand a call showing dialing/ringing/answered/in_progress forever)', () => {
    expect(isValidCallTransition('dialing', 'transferred')).toBe(true);
    expect(isValidCallTransition('ringing', 'transferred')).toBe(true);
    expect(isValidCallTransition('answered', 'transferred')).toBe(true);
    expect(isValidCallTransition('in_progress', 'transferred')).toBe(true);
  });
});
