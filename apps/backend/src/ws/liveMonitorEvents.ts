/**
 * Phase 10: pure mapping from Phase 8's `CallTransitionEvent` (the
 * `callEventBus` payload - see lib/callStateMachine.ts) to the exact
 * Live Monitor WS event-type strings spec section 54 names
 * (LIVE_MONITOR_EVENT_TYPES, packages/shared/src/liveMonitor.ts). Kept
 * pure/DB-free (mirrors lib/orchestration/callStateMachine.ts's own
 * "transition table stays pure" precedent) so it is directly
 * unit-testable without a database or a real WebSocket - see
 * liveMonitorEvents.test.ts.
 */
import type { CallStatus } from '@shivanshconnect/shared';
import type { LiveMonitorEventType } from '@shivanshconnect/shared';

/** Maps a call-status transition to the Live Monitor event type it should
 * surface as, or null when this particular transition has no distinct
 * Live Monitor event of its own (e.g. 'answered' collapses into
 * CALL_CONNECTED same as 'in_progress' - only emitted once, on whichever
 * of the two actually happens first for a given engine). */
export function mapTransitionToLiveMonitorEventType(from: CallStatus, to: CallStatus): LiveMonitorEventType | null {
  if (to === 'dialing' && from === 'queued') return 'CALL_STARTED';
  if (to === 'ringing') return 'CALL_RINGING';
  if ((to === 'answered' || to === 'in_progress') && from !== 'answered' && from !== 'in_progress') return 'CALL_CONNECTED';
  if (to === 'transfer_pending' || to === 'transferring') return 'CALL_TRANSFER_STARTED';
  if (to === 'transferred') return 'CALL_TRANSFER_CONNECTED';
  if (to === 'transfer_failed') return 'CALL_TRANSFER_FAILED';
  if (to === 'completed' || to === 'failed' || to === 'dnc' || to === 'cancelled') return 'CALL_ENDED';
  return null;
}
