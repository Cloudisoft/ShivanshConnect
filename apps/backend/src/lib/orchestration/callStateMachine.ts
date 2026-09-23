/**
 * Phase 6: call status state machine (master spec section 50).
 *
 * The single source of truth for which `calls.status` transitions are
 * valid. This module stays deliberately pure (no DB, no I/O) so it is
 * directly unit-testable (see callStateMachine.test.ts).
 *
 * Phase 8 extracts the actual enforcement + persistence + eventing seam
 * into `apps/backend/src/lib/callStateMachine.ts` - `transitionCallState()`
 * there is the one function every webhook handler and the dispatcher must
 * call to write a new `calls.status`, and it is built directly on top of
 * `isValidCallTransition()`/`isTerminalCallStatus()` exported from here.
 * Nothing here duplicates that logic - this file remains the transition
 * TABLE, that file is the transition EXECUTOR.
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
// Phase 8 note: 'dnc' is reachable from every non-terminal, in-call state
// (not just 'queued') because a caller can ask to be put on the Do Not
// Call list at any point during a live call (spec section 60) - the
// tool-call webhook handler (services/dncToolHandler.ts) transitions
// straight to 'dnc' from whatever state the call was actually in when the
// request was recognized.
const TRANSITIONS: Record<CallStatus, ReadonlySet<CallStatus>> = {
  queued: new Set(['dialing', 'cancelled', 'failed', 'dnc']),
  // 'in_progress' is reachable directly from 'dialing'/'ringing' too:
  // some engines (Vapi's own 'in-progress' status in particular) report
  // dial-connect-and-answer as a single transition without a distinct
  // separately-observable 'ringing'/'answered' event in between.
  // 'completed' is reachable directly from 'dialing'/'ringing' too: an
  // unanswered call (no-answer, or the caller declines/hangs up before
  // picking up) ends without ever passing through 'answered'/'in_progress'
  // - the engine's end-of-call-report still reports it as ended, not
  // failed, and rejecting that transition left real no-answer calls stuck
  // showing 'dialing' forever instead of their actual terminal outcome.
  dialing: new Set(['ringing', 'answered', 'in_progress', 'completed', 'failed', 'cancelled', 'voicemail', 'answering_machine', 'dnc']),
  ringing: new Set(['answered', 'in_progress', 'completed', 'failed', 'cancelled', 'voicemail', 'answering_machine', 'dnc']),
  answered: new Set(['in_progress', 'failed', 'completed', 'dnc']),
  in_progress: new Set(['transfer_pending', 'completed', 'failed', 'voicemail', 'answering_machine', 'dnc']),
  voicemail: new Set(['completed', 'failed', 'dnc']),
  answering_machine: new Set(['completed', 'failed', 'dnc']),
  transfer_pending: new Set(['transferring', 'transfer_failed', 'failed', 'dnc']),
  transferring: new Set(['transferred', 'transfer_failed', 'failed', 'dnc']),
  transferred: new Set([]),
  transfer_failed: new Set(['in_progress', 'completed', 'failed', 'dnc']),
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
