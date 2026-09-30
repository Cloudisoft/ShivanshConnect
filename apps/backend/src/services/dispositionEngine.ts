/**
 * Phase 8: the deterministic disposition engine (master spec section 20).
 *
 * A REAL rules engine - explicit, table-driven, never randomized, never an
 * LLM call. `decideDisposition()` is pure (no DB, no I/O) so every branch
 * is directly unit-testable against a synthetic `CallOutcomeSignals`
 * fixture (see dispositionEngine.test.ts). `assignDispositionForCall()` is
 * the only impure wrapper: it loads the real signals for a call, runs the
 * pure decision function, and writes exactly one `call_dispositions` row
 * (enforced by the DB's own UNIQUE (call_id) too, not just here).
 *
 * This is invoked automatically from the call state machine's terminal-
 * transition handler (services/callTerminalHandler.ts) - never manually
 * invoked by the UI. The one legitimate manual path is the supervisor
 * override endpoint (`PATCH /api/v1/calls/:id/disposition`,
 * routes/calls.ts), which writes `disposition_source = 'manual'` and never
 * calls this engine.
 */
import type { CallStatus, TransferStatus } from '@shivanshconnect/shared';
import { SYSTEM_DISPOSITION_CODES, type SystemDispositionCode } from '@shivanshconnect/shared';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** A minimum "the human actually said something and the agent talked back"
 * duration. Below this with no other explicit signal, a completed call
 * reads as a hang-up rather than a real connected conversation. Spec 20
 * calls this "duration above a small threshold" without pinning an exact
 * number - 8 seconds is long enough to rule out a pure ring-then-silence
 * artifact but short enough not to misclassify a genuinely brief but real
 * "no thanks, not interested, click" exchange as a non-connection. */
export const CONNECTED_DURATION_THRESHOLD_SECONDS = 8;

/** ended_reason values meaning the phone rang but nobody picked up - its
 * own distinct disposition (NO_ANSWER), not the generic DISCONNECTED
 * bucket a real technical failure belongs in. 'dial_timeout' is
 * dialTimeoutSweep.ts's own reason for a call that never connected to
 * anyone at all within its ~80s window - per explicit request ("Failed =
 * No answer"), that reads the same as a plain unanswered ring. */
const NO_ANSWER_ENDED_REASONS = new Set(['no-answer', 'customer-did-not-answer', 'dial_timeout']);

/** ended_reason values meaning the destination number itself is invalid/
 * disconnected - its own distinct disposition (NOT_IN_SERVICE), separate
 * from a generic technical DISCONNECTED failure or a plain no-answer. */
const NOT_IN_SERVICE_ENDED_REASONS = new Set(['invalid-number']);

/** ended_reason values that are a genuine technical/provider-side failure
 * with no meaningful interaction, and aren't specifically a no-answer or
 * an invalid number - the remaining DISCONNECTED bucket. */
const OTHER_NO_INTERACTION_ENDED_REASONS = new Set(['pipeline-error', 'twilio-failed', 'assistant-error', 'busy', 'customer-busy', 'dial-failed']);

/** Vapi has dozens of technical-failure reasons ('twilio-failed-to-connect-call',
 * 'pipeline-error-openai-llm-failed', 'call.start.error-...', ...). Any of
 * them on a call without a real conversation is DISCONNECTED - they used to
 * fall through to the HUNG_UP default. */
function isTechnicalFailureReason(reason: string | null): boolean {
  return reason != null && /error|failed|fault/i.test(reason);
}

/** The line went quiet and the provider ended it: a DISCONNECT when nothing
 * was really said, but a conversation that had already happened is still
 * CALL_CONNECTED (it used to be DISCONNECTED however long the call was). */
const SILENCE_ENDED_REASONS = new Set(['silence-timed-out']);

/** Union of every "no meaningful interaction occurred" reason above,
 * regardless of which specific disposition it maps to - used only to gate
 * CALL_CONNECTED (branch 4 below), never to pick a disposition itself. */
const NO_INTERACTION_ENDED_REASONS = new Set([...NO_ANSWER_ENDED_REASONS, ...NOT_IN_SERVICE_ENDED_REASONS, ...OTHER_NO_INTERACTION_ENDED_REASONS]);

/** ended_reason values that indicate the CALLER hung up (as opposed to a
 * provider-side failure) - distinguishes Hung Up from Disconnected. These
 * are duration-SENSITIVE: a 'customer-ended-call' after a real, lengthy
 * conversation is a successful CALL_CONNECTED the customer simply ended
 * naturally, not a hang-up - see branch 5's CALL_CONNECTED check, which
 * runs before this set is ever consulted (branch 8/9 below). */
const CALLER_HANGUP_ENDED_REASONS = new Set(['customer-ended-call', 'caller-hung-up', 'customer-hung-up']);

/** ended_reason values that mean no real interaction happened AT ALL,
 * regardless of whatever duration the provider reported for the call leg
 * - unlike CALLER_HANGUP_ENDED_REASONS above, these are NOT duration-
 * sensitive and always win over a duration-based CALL_CONNECTED read (see
 * branch 4). 'call.in-progress.error-assistant-did-not-receive-customer-
 * audio' is Vapi's real raw endedReason string (shown on its own
 * dashboard as "Assistant Did Not Receive Customer Audio") - per explicit
 * request, always disposed as HUNG_UP (never DISCONNECTED), since the
 * caller's side of the line never produced any audio at all. */
const ALWAYS_NO_INTERACTION_HANGUP_REASONS = new Set([
  'call.in-progress.error-assistant-did-not-receive-customer-audio',
  // services/noCallerAudioSweep.ts's own reason for the exact same
  // underlying condition, caught by our own backend backstop rather than
  // Vapi's real end-of-call-report - same disposition either way.
  'no_customer_audio',
]);

export interface CallOutcomeSignals {
  /** The terminal `calls.status` this call ended in. */
  status: CallStatus;
  endedReason: string | null;
  durationSeconds: number | null;
  /** True when the orchestration provider's own AMD/voicemail-detection
   * signal fired during the call (independent of the terminal status,
   * since some providers report AMD as an event rather than a status). */
  amdDetected: boolean;
  transferStatus: TransferStatus | null;
  /** True when a tool-call/function-call during the call explicitly
   * signaled the caller asked not to be called again (spec section 60). */
  dncRequested: boolean;
  /** Whether the call was ever answered (answered_at, an in-progress
   * transition, or an inbound call). Unknown (undefined) reads as answered. */
  answered?: boolean;
}

export interface DispositionDecision {
  code: SystemDispositionCode;
  confidence: number;
  reason: string;
}

/**
 * The explicit if/else decision table. Order matters: each branch is
 * checked in the fixed order below, and the FIRST matching branch wins -
 * exactly mirroring the discipline `leadEligibility.evaluateLeadEligibility`
 * already established for this codebase (fixed order, first match, never
 * silently combining reasons).
 */
export function decideDisposition(signals: CallOutcomeSignals): DispositionDecision {
  // 1. DNC always wins - a caller who asked not to be called again is
  // never reclassified as anything else, regardless of how the call
  // otherwise ended.
  if (signals.status === 'dnc' || signals.dncRequested) {
    return { code: 'DNC', confidence: 1, reason: 'Caller explicitly requested to be placed on the Do Not Call list during the call.' };
  }

  // 2. Voicemail / answering machine detected by AMD.
  //
  // signals.endedReason === 'voicemail' is Vapi's real, documented
  // end-of-call-report value when its voicemail detector ends the call
  // (docs.vapi.ai/calls/call-ended-reason) - the webhook handler
  // (routes/webhooks.ts) never sets calls.status to 'voicemail' itself
  // (that status models a live, still-in-progress detection a call can
  // continue past, not Vapi's actual end-of-call signal), so without
  // this check here every voicemail call fell through to the duration-
  // based CALL_CONNECTED branch below instead - a voicemail greeting
  // plus a left message is easily 8+ seconds, so real voicemail calls
  // were being disposed as if a live conversation had happened.
  if (signals.status === 'voicemail' || signals.endedReason === 'voicemail' || (signals.amdDetected && signals.status !== 'answering_machine')) {
    return { code: 'VOICEMAIL', confidence: 1, reason: 'Answering-machine detection identified voicemail.' };
  }
  if (signals.status === 'answering_machine') {
    return { code: 'ANSWERING_MACHINE', confidence: 1, reason: 'Answering-machine detection identified a non-voicemail answering machine.' };
  }

  // 3. Transfer outcomes.
  if (signals.status === 'transferred' || signals.transferStatus === 'succeeded') {
    return { code: 'TRANSFERRED', confidence: 1, reason: 'AI-initiated transfer connected successfully.' };
  }
  if (signals.status === 'transfer_failed' || signals.transferStatus === 'failed') {
    return {
      code: 'CALL_DISCONNECTED_IN_TRANSFER',
      confidence: 0.9,
      reason: 'Transfer was initiated but the caller disconnected during or after the transfer attempt.',
    };
  }

  // 4. A no-interaction-at-all reason always wins over a duration-based
  // "connected" read, even if the provider still reported a nonzero
  // duration for the call leg - e.g. Vapi's real
  // 'call.in-progress.error-assistant-did-not-receive-customer-audio'
  // means no audio from the caller ever reached the assistant at all, so
  // there was no conversation regardless of how long the leg stayed up.
  // Checked here, before branch 5's CALL_CONNECTED check, for exactly
  // that reason - unlike CALLER_HANGUP_ENDED_REASONS (branch 8 below),
  // which IS duration-sensitive (a real, lengthy conversation the
  // customer ended naturally is still CALL_CONNECTED).
  if (signals.endedReason != null && ALWAYS_NO_INTERACTION_HANGUP_REASONS.has(signals.endedReason)) {
    // On the Telnyx numbers Vapi also ends calls that never connected this
    // way: status still "queued", never ringing or answered, given up
    // after ~15s (415 of 422 on 30 Sep). Those are no-answers - recording
    // them as HUNG_UP undercounted no-answers and kept the leads from
    // being retried. A call that was answered keeps HUNG_UP as requested.
    if (signals.answered === false) {
      return { code: 'NO_ANSWER', confidence: 0.85, reason: 'The call never connected - no answer and no audio from the other side.' };
    }
    return { code: 'HUNG_UP', confidence: 0.85, reason: 'No audio from the caller ever reached the assistant.' };
  }

  // 5. Human answered and a real conversation occurred.
  const hadMeaningfulDuration = (signals.durationSeconds ?? 0) >= CONNECTED_DURATION_THRESHOLD_SECONDS;
  const noInteraction = signals.endedReason != null && NO_INTERACTION_ENDED_REASONS.has(signals.endedReason);
  if (signals.status === 'completed' && hadMeaningfulDuration && !noInteraction) {
    return { code: 'CALL_CONNECTED', confidence: 0.9, reason: 'Call connected and a conversation of meaningful duration occurred.' };
  }

  // 6. The phone simply rang with nobody picking up - its own distinct
  // outcome, not a "disconnect".
  if (signals.endedReason != null && NO_ANSWER_ENDED_REASONS.has(signals.endedReason)) {
    return { code: 'NO_ANSWER', confidence: 0.9, reason: 'The call rang but nobody answered.' };
  }

  // 7. The destination number itself is invalid/disconnected - distinct
  // from a generic technical failure or a plain no-answer.
  if (signals.endedReason != null && NOT_IN_SERVICE_ENDED_REASONS.has(signals.endedReason)) {
    return { code: 'NOT_IN_SERVICE', confidence: 0.9, reason: 'The destination number is not in service.' };
  }

  // 8. DISCONNECTED is reserved for a genuine technical/provider-side
  // failure with no meaningful interaction (busy, dial failed, an
  // assistant/pipeline error, a silence timeout) - never for a call the
  // CALLER actively ended, regardless of how short it was. A caller who
  // picks up and hangs up in the first second is still a real hang-up,
  // not a disconnect, and is never lumped in with no-answer/not-in-service
  // above either.
  if (noInteraction || isTechnicalFailureReason(signals.endedReason) || (signals.endedReason != null && SILENCE_ENDED_REASONS.has(signals.endedReason))) {
    return { code: 'DISCONNECTED', confidence: 0.8, reason: signals.endedReason ? `Provider reported a technical failure (${signals.endedReason}) with no meaningful interaction.` : 'Call ended with no meaningful interaction.' };
  }

  // 9. Caller hung up before a meaningful conversation - checked BEFORE
  // the generic fallback below so an explicit customer-ended-call/
  // caller-hung-up/customer-hung-up reason still gets its own clearer
  // reason text and higher confidence than the fallback default, for the
  // short-call case that never reached branch 5's CALL_CONNECTED check.
  if (signals.endedReason != null && CALLER_HANGUP_ENDED_REASONS.has(signals.endedReason)) {
    return { code: 'HUNG_UP', confidence: 0.85, reason: 'Caller ended the call before a full conversation concluded.' };
  }

  // 10. Fallback: a call with no explicit technical-failure or
  // caller-hangup reason, and no clean "connected" signal, reads as a
  // hang-up rather than a disconnect by default - DISCONNECTED/NO_ANSWER/
  // NOT_IN_SERVICE are never the default outcome, only ever an explicit
  // signal (branches 6-8 above), and an always-no-interaction reason was
  // already handled in branch 4, above CALL_CONNECTED.
  return { code: 'HUNG_UP', confidence: 0.6, reason: 'Call ended quickly without a clear connected outcome.' };
}

/** Loads the real signals for `call` from its own columns plus its
 * call_events history (AMD/tool-call markers), the only impure part of
 * this module. */
export async function loadCallOutcomeSignals(supabase: Supabase, call: Record<string, any>): Promise<CallOutcomeSignals> {
  const { data: events } = await supabase
    .from('call_events')
    .select('event_type, payload')
    .eq('call_id', call.id)
    .order('occurred_at', { ascending: true });

  const rows: Array<{ event_type: string; payload: any }> = events ?? [];
  const amdDetected = rows.some((e) => e.event_type === 'call.amd_detected' || e.payload?.amd === true || e.payload?.status === 'voicemail' || e.payload?.status === 'answering_machine');
  const dncRequested = rows.some((e) => e.event_type === 'call.dnc_requested');
  const answered =
    Boolean(call.answered_at) ||
    call.direction === 'inbound' ||
    rows.some((e) => e.event_type === 'call.transitioned.in_progress' || e.event_type === 'call.transitioned.answered' || e.event_type === 'call.inbound_answered');

  return {
    status: call.status as CallStatus,
    endedReason: call.ended_reason ?? null,
    durationSeconds: call.duration_seconds ?? null,
    amdDetected,
    transferStatus: (call.transfer_status as TransferStatus | null) ?? null,
    dncRequested,
    answered,
  };
}

async function resolveDispositionRowId(supabase: Supabase, orgId: string, code: string): Promise<string> {
  // Org-custom dispositions never share a code with a system default (the
  // seed only ever inserts SYSTEM_DISPOSITION_CODES with organization_id
  // null) - a plain system-row lookup is always correct for an
  // engine-derived code.
  const { data, error } = await supabase.from('dispositions').select('id').is('organization_id', null).eq('code', code).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`System disposition code "${code}" is missing from the dispositions table.`);
  return data.id;
}

export interface AssignDispositionResult {
  dispositionId: string;
  code: SystemDispositionCode;
  confidence: number;
  reason: string;
}

/** Assigns (upserts, honoring the UNIQUE (call_id) constraint) exactly one
 * ENGINE-sourced disposition for a call. Never overwrites a MANUAL
 * override that a supervisor already applied - the engine only ever
 * writes when no row exists yet or the existing row is itself
 * engine-sourced (e.g. a webhook replay re-deriving the same call). */
export async function assignDispositionForCall(supabase: Supabase, call: Record<string, any>): Promise<AssignDispositionResult> {
  // Every terminal call transition (Live Monitor's real-time status/
  // disposition update) waits on this function before broadcasting -
  // `existing` doesn't depend on the decision at all, so it runs
  // alongside loadCallOutcomeSignals() instead of after it, cutting one
  // round trip off the critical path on the common (non-manual-override)
  // case every call actually takes.
  const [signals, existing] = await Promise.all([
    loadCallOutcomeSignals(supabase, call),
    supabase
      .from('call_dispositions')
      .select('id, disposition_source')
      .eq('call_id', call.id)
      .maybeSingle()
      .then((r) => r.data),
  ]);
  const decision = decideDisposition(signals);
  const dispositionId = await resolveDispositionRowId(supabase, call.organization_id, decision.code);

  if (existing && existing.disposition_source === 'manual') {
    // A supervisor already corrected this call - the engine never
    // clobbers a manual override.
    const { data: current } = await supabase.from('call_dispositions').select('*').eq('call_id', call.id).maybeSingle();
    let currentCode: SystemDispositionCode | string = decision.code;
    if (current?.disposition_id) {
      const { data: currentDisposition } = await supabase.from('dispositions').select('code').eq('id', current.disposition_id).maybeSingle();
      if (currentDisposition?.code) currentCode = currentDisposition.code;
    }
    return { dispositionId: current?.disposition_id, code: currentCode as SystemDispositionCode, confidence: current?.disposition_confidence ?? decision.confidence, reason: current?.disposition_reason ?? decision.reason };
  }

  if (existing) {
    await supabase
      .from('call_dispositions')
      .update({ disposition_id: dispositionId, disposition_source: 'engine', disposition_confidence: decision.confidence, disposition_reason: decision.reason, assigned_at: new Date().toISOString(), assigned_by: null })
      .eq('id', existing.id);
  } else {
    await supabase.from('call_dispositions').insert({
      call_id: call.id,
      organization_id: call.organization_id,
      disposition_id: dispositionId,
      disposition_source: 'engine',
      disposition_confidence: decision.confidence,
      disposition_reason: decision.reason,
      assigned_by: null,
    });
  }

  return { dispositionId, code: decision.code, confidence: decision.confidence, reason: decision.reason };
}

export { SYSTEM_DISPOSITION_CODES };
