/**
 * Phase 10: Live Monitor real-time event types (master spec sections
 * 18/19/54). Shared between the backend WS broadcaster
 * (apps/backend/src/ws/liveMonitor.ts) and the frontend Live Monitor page
 * (apps/frontend/src/pages/LiveMonitorPage.tsx) so both sides are built
 * against the exact same literal event-type strings - spec section 54
 * names these exactly, so they are never re-derived or paraphrased
 * per-side.
 */

export const LIVE_MONITOR_EVENT_TYPES = [
  'CALL_STARTED',
  'CALL_RINGING',
  'CALL_CONNECTED',
  'TRANSCRIPT_UPDATED',
  'CALL_TRANSFER_STARTED',
  'CALL_TRANSFER_CONNECTED',
  'CALL_TRANSFER_FAILED',
  'CALL_ENDED',
] as const;
export type LiveMonitorEventType = (typeof LIVE_MONITOR_EVENT_TYPES)[number];

/** The call statuses that make a call show up in the Live Monitor's
 * active-calls table/snapshot - anything not yet terminal and past pure
 * queueing. */
export const LIVE_MONITOR_ACTIVE_STATUSES = [
  'dialing',
  'ringing',
  'answered',
  'in_progress',
  'voicemail',
  'answering_machine',
  'transfer_pending',
  'transferring',
] as const;

export interface LiveMonitorActiveCall {
  id: string;
  organization_id: string;
  engine: 'vapi' | 'pipecat';
  status: string;
  direction: string;
  customer_number: string;
  started_at: string | null;
  answered_at: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  lead_id: string | null;
  lead_name: string | null;
  ai_agent_id: string | null;
  ai_agent_name: string | null;
  voice_id: string | null;
  voice_name: string | null;
  /** The call's own server-resolved transfer destination (set at
   * call-creation time from the campaign/agent's configuration, spec
   * 19/8L) - shown by the frontend's Transfer confirmation, never
   * editable there. Null when this call has no transfer destination
   * configured at all. */
  transfer_destination_e164: string | null;
}

export interface LiveMonitorTranscriptSegment {
  id: string;
  call_id: string;
  segment_index: number;
  speaker: 'ai' | 'caller';
  start_ms: number;
  end_ms: number | null;
  text: string;
}

/** The exact envelope pushed down the WS stream for every event. `call`
 * carries the current LiveMonitorActiveCall projection (or null once a
 * call has ended and been removed from the active set); `segment` is only
 * present on TRANSCRIPT_UPDATED. */
export interface LiveMonitorWsEvent {
  type: LiveMonitorEventType;
  call_id: string;
  organization_id: string;
  occurred_at: string;
  call: LiveMonitorActiveCall | null;
  segment?: LiveMonitorTranscriptSegment;
  from_status?: string;
  to_status?: string;
}

/** The very first message sent on every connection: the snapshot of
 * currently-active calls for the caller's own organization. */
export interface LiveMonitorSnapshot {
  type: 'SNAPSHOT';
  calls: LiveMonitorActiveCall[];
}

/** Sent by the server on a fixed interval for as long as the connection is
 * open (see ws/liveMonitorRoutes.ts) purely so the frontend can tell a
 * genuinely silent connection apart from one that just has nothing to
 * report right now - some calls can sit `dialing`/`in_progress` for
 * minutes with zero real events. Without this, a WS connection an
 * intermediary proxy has silently dropped (no close frame reaches either
 * side, which real proxies do under idle timeouts) looks identical to
 * "the socket is fine, there's just nothing new" - Live Monitor freezes on
 * stale state and never reconnects. The frontend watches for a gap between
 * these and force-reconnects if one is missed. */
export interface LiveMonitorHeartbeat {
  type: 'HEARTBEAT';
}
