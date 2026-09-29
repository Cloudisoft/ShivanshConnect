/**
 * "This call just hung up" - from Vapi's status-update 'ended', which
 * arrives the moment the line drops, seconds before the end-of-call-report
 * that carries the outcome (duration, cost, ended reason) and drives the
 * real terminal transition + disposition.
 *
 * Used only to take the call off Live Monitor immediately (its panel,
 * audio and transcript are disposed of right away). It never changes the
 * call row: the status transition stays with end-of-call-report (see
 * routes/webhooks.ts on why 'ended' must not map to 'completed'), and
 * ended_at stays unset until then so services/callEndDataRepair.ts can
 * still find calls whose report never arrived.
 */
import { callEventBus } from './callStateMachine.js';

export interface CallHungUpEvent {
  callId: string;
  organizationId: string;
}

const HUNG_UP_TTL_MS = 15 * 60_000;
const hungUpAt = new Map<string, number>();

export function markCallHungUp(event: CallHungUpEvent): void {
  const now = Date.now();
  if (hungUpAt.size > 5000) {
    for (const [id, at] of hungUpAt) if (now - at > HUNG_UP_TTL_MS) hungUpAt.delete(id);
  }
  if (hungUpAt.has(event.callId)) return;
  hungUpAt.set(event.callId, now);
  callEventBus.emit('call.hungup', event);
}

/** True for a call that hung up recently but whose report hasn't landed. */
export function isCallHungUp(callId: string): boolean {
  const at = hungUpAt.get(callId);
  return at !== undefined && Date.now() - at < HUNG_UP_TTL_MS;
}
