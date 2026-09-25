/**
 * Phase 10: the Live Monitor broadcaster - subscribes to Phase 8's
 * `callEventBus` (lib/callStateMachine.ts) and Phase 10's own
 * `transcriptEventBus` (lib/transcriptEventBus.ts), and calls back with a
 * fully-shaped `LiveMonitorWsEvent` for exactly the events belonging to
 * ONE organization.
 *
 * This is the seam ws/liveMonitorRoutes.ts wires a real WebSocket
 * connection's `send()` into, and the seam liveMonitorBroadcaster.test.ts
 * exercises directly (an in-process callback) without ever needing a real
 * WS client - per the task brief, "an equivalent in-process event capture
 * in tests" is the intended way to prove ordering/isolation.
 *
 * HARD REQUIREMENT (spec + task brief): org isolation. Every event this
 * module ever calls `onEvent` with is first filtered by
 * `event.organizationId === organizationId` - an org A call transition or
 * transcript segment must NEVER reach an org B subscriber. See
 * liveMonitorBroadcaster.test.ts's explicit cross-org test.
 */
import type { CallTransitionEvent } from '../lib/callStateMachine.js';
import { callEventBus } from '../lib/callStateMachine.js';
import { transcriptEventBus, type LiveTranscriptSegmentEvent } from '../lib/transcriptEventBus.js';
import { mapTransitionToLiveMonitorEventType } from './liveMonitorEvents.js';
import { buildLiveMonitorActiveCalls } from '../services/liveMonitorQuery.js';
import type { getSupabaseAdmin } from '../lib/supabase.js';
import type { LiveMonitorWsEvent } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/**
 * Subscribes `onEvent` to every Live Monitor WS event for `organizationId`
 * only. Returns an unsubscribe function - callers MUST call it when the
 * connection/test is done (ws/liveMonitorRoutes.ts does this on the
 * socket's 'close' event) since callEventBus/transcriptEventBus are
 * plain, long-lived process-wide EventEmitters.
 */
export function registerLiveMonitorSubscriber(
  supabase: Supabase,
  organizationId: string,
  onEvent: (event: LiveMonitorWsEvent) => void,
): () => void {
  const onTransition = (event: CallTransitionEvent) => {
    if (event.organizationId !== organizationId) return; // cross-org isolation - see header comment
    const type = mapTransitionToLiveMonitorEventType(event.from, event.to);
    if (!type) return;

    // CALL_ENDED always sends call: null (the frontend just removes the
    // id from its active-calls map) - dispatch it immediately rather
    // than waiting on 5 DB round trips (campaign/lead/agent/version/
    // voice) whose result would be thrown away unused. That wait was
    // real, measurable delay on exactly "should be automatically
    // removed as soon as the call is ended".
    if (type === 'CALL_ENDED') {
      onEvent({
        type,
        call_id: event.callId,
        organization_id: event.organizationId,
        occurred_at: new Date().toISOString(),
        call: null,
        from_status: event.from,
        to_status: event.to,
      });
      return;
    }

    void buildLiveMonitorActiveCalls(supabase, [event.call]).then(([call]) => {
      onEvent({
        type,
        call_id: event.callId,
        organization_id: event.organizationId,
        occurred_at: new Date().toISOString(),
        call: call ?? null,
        from_status: event.from,
        to_status: event.to,
      });
    });
  };

  const onSegment = (event: LiveTranscriptSegmentEvent) => {
    if (event.organizationId !== organizationId) return; // cross-org isolation - see header comment
    onEvent({
      type: 'TRANSCRIPT_UPDATED',
      call_id: event.callId,
      organization_id: event.organizationId,
      occurred_at: new Date().toISOString(),
      call: null,
      segment: event.segment,
    });
  };

  callEventBus.on('call.transitioned', onTransition);
  transcriptEventBus.on('segment', onSegment);

  return () => {
    callEventBus.off('call.transitioned', onTransition);
    transcriptEventBus.off('segment', onSegment);
  };
}
