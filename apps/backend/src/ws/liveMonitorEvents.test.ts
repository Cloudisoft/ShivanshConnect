import { describe, expect, it } from 'vitest';
import { mapTransitionToLiveMonitorEventType } from './liveMonitorEvents.js';

describe('mapTransitionToLiveMonitorEventType (Phase 10)', () => {
  it('maps queued -> dialing to CALL_STARTED', () => {
    expect(mapTransitionToLiveMonitorEventType('queued', 'dialing')).toBe('CALL_STARTED');
  });

  it('maps any -> ringing to CALL_RINGING', () => {
    expect(mapTransitionToLiveMonitorEventType('dialing', 'ringing')).toBe('CALL_RINGING');
  });

  it('maps the first arrival at answered/in_progress to CALL_CONNECTED, but not a repeat', () => {
    expect(mapTransitionToLiveMonitorEventType('ringing', 'answered')).toBe('CALL_CONNECTED');
    expect(mapTransitionToLiveMonitorEventType('dialing', 'in_progress')).toBe('CALL_CONNECTED');
    // Already connected - answered -> in_progress is not a NEW connection event.
    expect(mapTransitionToLiveMonitorEventType('answered', 'in_progress')).toBeNull();
  });

  it('maps the transfer sub-flow to the exact spec event names', () => {
    expect(mapTransitionToLiveMonitorEventType('in_progress', 'transfer_pending')).toBe('CALL_TRANSFER_STARTED');
    expect(mapTransitionToLiveMonitorEventType('transfer_pending', 'transferring')).toBe('CALL_TRANSFER_STARTED');
    expect(mapTransitionToLiveMonitorEventType('transferring', 'transferred')).toBe('CALL_TRANSFER_CONNECTED');
    expect(mapTransitionToLiveMonitorEventType('transferring', 'transfer_failed')).toBe('CALL_TRANSFER_FAILED');
  });

  it('maps every terminal status to CALL_ENDED', () => {
    for (const to of ['completed', 'failed', 'dnc', 'cancelled'] as const) {
      expect(mapTransitionToLiveMonitorEventType('in_progress', to)).toBe('CALL_ENDED');
    }
  });

  it('returns null for a transition with no distinct Live Monitor event', () => {
    expect(mapTransitionToLiveMonitorEventType('queued', 'cancelled')).toBe('CALL_ENDED');
    expect(mapTransitionToLiveMonitorEventType('queued', 'failed')).toBe('CALL_ENDED');
    // A same-status no-op transition (idempotent redelivery) never
    // re-emits an event.
    expect(mapTransitionToLiveMonitorEventType('in_progress', 'in_progress' as any)).toBeNull();
  });
});
