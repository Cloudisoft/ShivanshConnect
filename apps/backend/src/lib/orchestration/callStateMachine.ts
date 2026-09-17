/**
 * Phase 6: call status state machine (master spec section 50).
 *
 * The single source of truth for which `calls.status` transitions are
 * valid. Webhook handlers (routes/webhooks.ts) must call
 * isValidCallTransition() before writing a new status and reject/log an
 * invalid one rather than silently overwriting - an out-of-order or
 * duplicate webhook delivery must never corrupt the call's status history.
 */

import type { CallStatus } from '@shivanshconnect/shared';

const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  'completed',
  'failed',
  'dnc',
  'cancelled',
  'transferred',
]);

/** Adjacency list of allowed next statuses per current status. A call can
 * always fail from any non-terminal state (real-world engines can report a
 * hard failure at any point), and 'transfer_failed' returns to
 * 'in_progress' so the agent can keep talking to the caller after a failed
 * transfer attempt rather than getting stuck. */
const TRANSITIONS: Record<CallStatus, ReadonlySet<CallStatus>> = {
  queued: new Set(['dialing', 'cancelled', 'failed', 'dnc']),
  // 'in_progress' is reachable directly from 'dialing'/'ringing' too:
  // some engines (Vapi's own 'in-progress' status in particular) report
  // dial-connect-and-answer as a single transition without a distinct
  // separately-observable 'ringing'/'answered' event in between.
  dialing: new Set(['ringing', 'answered', 'in_progress', 'failed', 'cancelled', 'voicemail', 'answering_machine']),
  ringing: new Set(['answered', 'in_progress', 'failed', 'cancelled', 'voicemail', 'answering_machine']),
  answered: new Set(['in_progress', 'failed', 'completed']),
  in_progress: new Set(['transfer_pending', 'completed', 'failed', 'voicemail', 'answering_machine']),
  voicemail: new Set(['completed', 'failed']),
  answering_machine: new Set(['completed', 'failed']),
  transfer_pending: new Set(['transferring', 'transfer_failed', 'failed']),
  transferring: new Set(['transferred', 'transfer_failed', 'failed']),
  transferred: new Set([]),
  transfer_failed: new Set(['in_progress', 'completed', 'failed']),
  completed: new Set([]),
  failed: new Set([]),
  dnc: new Set([]),
  cancelled: new Set([]),
};

export function isTerminalCallStatus(status: CallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** True for a same-status "transition" too (an idempotent re-delivery of
 * the same lifecycle event should never be rejected as invalid - it is
 * simply a no-op the caller can skip writing). */
export function isValidCallTransition(from: CallStatus, to: CallStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.has(to) ?? false;
}
