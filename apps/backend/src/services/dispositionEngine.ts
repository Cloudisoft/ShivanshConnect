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

/** ended_reason values that mean the call never really connected (no
 * meaningful interaction occurred) - the "early/immediate hangup" branch,
 * as opposed to a hang-up mid-conversation. */
const NO_INTERACTION_ENDED_REASONS = new Set([
  'no-answer',
  'customer-did-not-answer',
  'silence-timed-out',
  'pipeline-error',
  'twilio-failed',
  'assistant-error',
  'busy',
  'dial-failed',
  'invalid-number',
]);

/** ended_reason values that indicate the CALLER hung up (as opposed to a
 * provider-side failure) - distinguishes Hung Up from Disconnected. */
const CALLER_HANGUP_ENDED_REASONS = new Set(['customer-ended-call', 'caller-hung-up', 'customer-hung-up']);

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
  if (signals.status === 'voicemail' || (signals.amdDetected && signals.status !== 'answering_machine')) {
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

  // 4. Human answered and a real conversation occurred.
  const hadMeaningfulDuration = (signals.durationSeconds ?? 0) >= CONNECTED_DURATION_THRESHOLD_SECONDS;
  const noInteraction = signals.endedReason != null && NO_INTERACTION_ENDED_REASONS.has(signals.endedReason);
  if (signals.status === 'completed' && hadMeaningfulDuration && !noInteraction) {
    return { code: 'CALL_CONNECTED', confidence: 0.9, reason: 'Call connected and a conversation of meaningful duration occurred.' };
  }

  // 5. DISCONNECTED is reserved for a genuine technical/no-interaction
  // failure (no-answer, busy, dial failed, provider/assistant error,
  // silence timeout) - never for a call the CALLER actively ended,
  // regardless of how short it was. A caller who picks up and hangs up
  // in the first second is still a real hang-up, not a disconnect.
  if (noInteraction) {
    return { code: 'DISCONNECTED', confidence: 0.8, reason: signals.endedReason ? `Provider reported an early disconnect (${signals.endedReason}) with no meaningful interaction.` : 'Call ended with no meaningful interaction.' };
  }

  // 6. Caller hung up - checked BEFORE any generic "short call" fallback
  // so an explicit customer-ended-call reason always wins over duration
  // alone, no matter how brief the call was.
  if (signals.endedReason != null && CALLER_HANGUP_ENDED_REASONS.has(signals.endedReason)) {
    return { code: 'HUNG_UP', confidence: 0.85, reason: 'Caller ended the call before a full conversation concluded.' };
  }

  // 7. Fallback: a call with no explicit technical-failure or
  // caller-hangup reason, and no clean "connected" signal, reads as a
  // hang-up rather than a disconnect by default - DISCONNECTED is never
  // the default outcome, only ever an explicit technical signal (branch
  // 5 above).
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

  return {
    status: call.status as CallStatus,
    endedReason: call.ended_reason ?? null,
    durationSeconds: call.duration_seconds ?? null,
    amdDetected,
    transferStatus: (call.transfer_status as TransferStatus | null) ?? null,
    dncRequested,
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
  const signals = await loadCallOutcomeSignals(supabase, call);
  const decision = decideDisposition(signals);
  const dispositionId = await resolveDispositionRowId(supabase, call.organization_id, decision.code);

  const { data: existing } = await supabase.from('call_dispositions').select('id, disposition_source').eq('call_id', call.id).maybeSingle();
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
