/**
 * The connected-but-no-caller-audio sweep, per explicit request: "one
 * error prominently... assistant didn't get sound or voice on calls
 * please resolve this" plus "end the call without wasting any more
 * credits."
 *
 * Vapi's own silenceTimeoutSeconds (lib/orchestration/vapi.ts, set to 30s)
 * is meant to end a call automatically when the line goes quiet, but in
 * practice a call whose audio path is broken end-to-end (a one-way-audio
 * carrier/SIP issue, not a caller who is simply quiet) can sit
 * 'answered'/'in_progress' for many minutes without Vapi's own detection
 * ever firing - the exact pattern behind Vapi's own real
 * 'call.in-progress.error-assistant-did-not-receive-customer-audio'
 * ended_reason (already handled by dispositionEngine.ts's
 * ALWAYS_NO_INTERACTION_HANGUP_REASONS when VAPI itself eventually reports
 * it), and behind the "calls stuck showing In Progress for 9-12+ minutes"
 * symptom reported in Live Monitor. This sweep is our own backend-side
 * backstop for the exact same underlying condition, catching it directly
 * from what we can observe ourselves rather than waiting on Vapi's own
 * end-of-call-report:
 *
 * A call that connected (answered_at is set) but has NEVER had a single
 * transcript segment from the caller (call_transcript_segments, speaker =
 * 'caller') after a generous window has no real audio flowing from the
 * caller's side, full stop - there is no "conversation" here to protect,
 * unlike a call that connected and genuinely has caller segments (that one
 * is left alone, exactly like dialTimeoutSweep.ts leaves alone anything
 * that already has answered_at set).
 *
 * Ends the call at the provider first (never wastes credits on a call
 * already known to be broken), then disposes it locally through the real
 * state machine - same pattern as dialTimeoutSweep.ts and
 * routes/liveMonitor.ts's supervisor "End call" action.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { transitionCallState } from '../lib/callStateMachine.js';
import { resolveProviderForCall } from '../lib/orchestration/resolveProvider.js';
import { OrchestrationProviderError, OrchestrationProviderNotConfiguredError } from '../lib/orchestration/index.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Only genuinely connected statuses - a call here reached a human (or,
 * per the state machine, something that looked like one at connect time).
 * Deliberately NOT 'voicemail'/'answering_machine' (AMD already resolved
 * those to a machine, a wholly different and already-handled case) or
 * 'transfer_pending'/'transferring' (mid-transfer, never second-guessed
 * here). */
const CONNECTED_STATUSES = ['answered', 'in_progress'];

/** Generous well past a normal greeting-and-response exchange, and past
 * Vapi's own 30s silenceTimeoutSeconds - this only ever fires for a call
 * Vapi's own detection has already had a full opportunity to catch and
 * didn't. */
const NO_CALLER_AUDIO_TIMEOUT_MS = Number.parseInt(process.env.CALL_NO_CALLER_AUDIO_TIMEOUT_MS ?? '', 10) || 90 * 1000;
const SWEEP_INTERVAL_MS = Number.parseInt(process.env.CALL_NO_CALLER_AUDIO_SWEEP_INTERVAL_MS ?? '', 10) || 15 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export interface NoCallerAudioSweepResult {
  checked: number;
  disposed: number;
}

async function endCallAtProvider(supabase: Supabase, call: Record<string, any>): Promise<void> {
  const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
  if (!providerCallId) return;
  try {
    const provider = await resolveProviderForCall(supabase, call);
    await provider.endCall(providerCallId);
  } catch (err) {
    if (!(err instanceof OrchestrationProviderError) && !(err instanceof OrchestrationProviderNotConfiguredError)) {
      // eslint-disable-next-line no-console
      console.error('noCallerAudioSweep: endCall() at provider failed for call', call.id, err);
    }
  }
}

/** One sweep across every organization - never throws. */
export async function runNoCallerAudioSweep(): Promise<NoCallerAudioSweepResult> {
  const supabase = getSupabaseAdmin();
  const result: NoCallerAudioSweepResult = { checked: 0, disposed: 0 };
  const cutoff = new Date(Date.now() - NO_CALLER_AUDIO_TIMEOUT_MS).toISOString();

  const { data: candidates } = await supabase
    .from('calls')
    .select('id, organization_id, engine, vapi_call_id, pipecat_call_id, status, answered_at')
    .in('status', CONNECTED_STATUSES)
    .lte('answered_at', cutoff)
    .limit(500);

  const rows: Record<string, any>[] = (candidates ?? []).filter((c) => c.answered_at != null);
  if (rows.length === 0) return result;

  const { data: callerSegments } = await supabase
    .from('call_transcript_segments')
    .select('call_id')
    .eq('speaker', 'caller')
    .in('call_id', rows.map((r) => r.id));

  const callIdsWithCallerAudio = new Set((callerSegments ?? []).map((r: any) => r.call_id));
  const staleRows = rows.filter((r) => !callIdsWithCallerAudio.has(r.id));
  result.checked = staleRows.length;

  for (const call of staleRows) {
    try {
      await endCallAtProvider(supabase, call);
      const answeredAtMs = Date.parse(call.answered_at);
      const durationSeconds = Number.isFinite(answeredAtMs) ? Math.round((Date.now() - answeredAtMs) / 1000) : null;
      const applied = await transitionCallState(supabase, call.id, 'completed', {
        ended_at: new Date().toISOString(),
        ended_reason: 'no_customer_audio',
        duration_seconds: durationSeconds,
      });
      if (applied.applied) result.disposed += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('noCallerAudioSweep: failed to dispose call', call.id, err);
    }
  }

  return result;
}

function runTickOnce(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  runNoCallerAudioSweep()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('noCallerAudioSweep: tick failed', err);
    })
    .finally(() => {
      tickInFlight = false;
    });
}

/** Runs one tick immediately at boot, then on SWEEP_INTERVAL_MS after that
 * - same "don't wait out a full interval after every restart" pattern as
 * callReconciliation.ts/dialTimeoutSweep.ts. */
export function startNoCallerAudioSweep(): void {
  if (intervalHandle) return;
  runTickOnce();
  intervalHandle = setInterval(runTickOnce, SWEEP_INTERVAL_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopNoCallerAudioSweep(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
