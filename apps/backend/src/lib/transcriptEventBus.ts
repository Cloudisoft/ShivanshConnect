/**
 * Phase 10: in-process event bus for live (mid-call) transcript segments,
 * the same pattern as lib/callStateMachine.ts's `callEventBus` (a plain
 * EventEmitter, not a durable queue - see that module's header comment
 * for the documented seam this is deliberately built on). Whatever writes
 * a new call_transcript_segments row DURING a live call
 * (services/liveTranscriptIngestion.ts) emits here immediately afterwards
 * so ws/liveMonitor.ts can push a TRANSCRIPT_UPDATED event without
 * polling the DB.
 */
import { EventEmitter } from 'node:events';

export interface LiveTranscriptSegmentEvent {
  callId: string;
  organizationId: string;
  segment: {
    id: string;
    call_id: string;
    segment_index: number;
    speaker: 'ai' | 'caller';
    start_ms: number;
    end_ms: number | null;
    text: string;
  };
}

export const transcriptEventBus = new EventEmitter();
transcriptEventBus.setMaxListeners(100);

export function emitLiveTranscriptSegment(event: LiveTranscriptSegmentEvent): void {
  transcriptEventBus.emit('segment', event);
}
