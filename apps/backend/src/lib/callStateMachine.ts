/**
 * Phase 8: the call state machine's EXECUTOR (master spec section 50).
 *
 * `apps/backend/src/lib/orchestration/callStateMachine.ts` is the pure
 * transition TABLE (`isValidCallTransition`/`isTerminalCallStatus`). This
 * module is the single place every call-status write actually goes
 * through: `transitionCallState()` validates the transition against that
 * table, rejects and LOGS (never silently applies) an invalid one, persists
 * the new status plus any extra columns for this transition (ended_at,
 * ended_reason, duration_seconds, cost, answered_at, ...), and emits a real
 * internal event other subsystems subscribe to.
 *
 * Event bus: `callEventBus` is a plain in-process `EventEmitter`. This is
 * intentionally NOT a durable queue - it is the documented seam where
 * Phase 54's broader real-time event architecture (a real pub/sub layer,
 * likely Redis-backed once Phase 15 lands BullMQ/Redis) will attach later.
 * Anything that must survive a process restart or be visible across
 * processes is written to the `calls`/`call_events` tables directly, by
 * `transitionCallState()` itself, BEFORE the in-process event fires - the
 * event is a same-process notification only, never the source of truth.
 *
 * Terminal handling: when a transition lands on a terminal status
 * (completed/failed/dnc/cancelled/transferred), this module awaits
 * `handleTerminalCall()` (services/callTerminalHandler.ts) directly, in
 * addition to emitting `call.terminal` on the bus. Direct-and-awaited is
 * deliberate: disposition assignment and the campaign_leads update it
 * drives (the single-source-of-truth requirement in the Phase 8 spec) must
 * complete before the webhook handler that triggered the transition
 * returns, so a test (or a real caller) can rely on it having happened.
 * The bus event exists for OTHER subscribers (e.g. a future live-monitor
 * UI push) that don't need that same-request guarantee.
 */
import { EventEmitter } from 'node:events';
import type { CallStatus } from '@shivanshconnect/shared';
import { isTerminalCallStatus, isValidCallTransition } from './orchestration/callStateMachine.js';
import type { getSupabaseAdmin } from './supabase.js';

export { isTerminalCallStatus, isValidCallTransition };

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface CallTransitionEvent {
  callId: string;
  organizationId: string;
  from: CallStatus;
  to: CallStatus;
  call: Record<string, any>;
  context: Record<string, unknown>;
}

/** In-process call-lifecycle event bus. See header comment. */
export const callEventBus = new EventEmitter();
callEventBus.setMaxListeners(100);

export type TransitionRejectReason = 'invalid_transition' | 'noop_same_status' | 'call_not_found';

export interface TransitionCallStateResult {
  applied: boolean;
  call: Record<string, any> | null;
  reason?: TransitionRejectReason;
}

/** A handler invoked (awaited) synchronously whenever a transition lands
 * on a terminal status. Registered once by services/callTerminalHandler.ts
 * at startup via `registerTerminalCallHandler()` - kept as an injectable
 * hook (rather than a hard import) so this module never has to import the
 * disposition/campaign services directly and risk a circular dependency. */
type TerminalCallHandler = (supabase: Supabase, event: CallTransitionEvent) => Promise<void>;
let terminalCallHandler: TerminalCallHandler | null = null;

export function registerTerminalCallHandler(handler: TerminalCallHandler): void {
  terminalCallHandler = handler;
}

/** Test-only escape hatch. */
export function _resetTerminalCallHandlerForTests(): void {
  terminalCallHandler = null;
}

/**
 * The single function that writes a new `calls.status`. Never write
 * `calls.status` directly anywhere else in webhook/dispatcher/origination
 * code - always go through this.
 *
 * `context` is both (a) extra columns to persist on `calls` alongside the
 * new status (e.g. `{ ended_at, ended_reason, duration_seconds, cost }`)
 * and (b) the payload attached to the emitted event / call_events row.
 */
export async function transitionCallState(
  supabase: Supabase,
  callId: string,
  newState: CallStatus,
  context: Record<string, unknown> = {},
): Promise<TransitionCallStateResult> {
  const { data: call, error } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (error) throw error;
  if (!call) return { applied: false, call: null, reason: 'call_not_found' };

  const from = call.status as CallStatus;

  if (from === newState) {
    // Idempotent re-delivery of the same lifecycle event - a genuine
    // no-op, never an error and never re-applied/re-emitted.
    return { applied: false, call, reason: 'noop_same_status' };
  }

  if (!isValidCallTransition(from, newState)) {
    await supabase.from('call_events').insert({
      call_id: callId,
      organization_id: call.organization_id,
      event_type: 'call.invalid_transition_rejected',
      payload: { from, to: newState, context },
    });
    return { applied: false, call, reason: 'invalid_transition' };
  }

  const { data: updated, error: updateError } = await supabase
    .from('calls')
    .update({ status: newState, ...context })
    .eq('id', callId)
    .select('*')
    .single();
  if (updateError) throw updateError;

  await supabase.from('call_events').insert({
    call_id: callId,
    organization_id: call.organization_id,
    event_type: `call.transitioned.${newState}`,
    payload: { from, to: newState, context },
  });

  const event: CallTransitionEvent = { callId, organizationId: call.organization_id, from, to: newState, call: updated, context };
  callEventBus.emit('call.transitioned', event);

  if (isTerminalCallStatus(newState)) {
    callEventBus.emit('call.terminal', event);
    if (terminalCallHandler) {
      await terminalCallHandler(supabase, event);
    }
  }

  return { applied: true, call: updated };
}
