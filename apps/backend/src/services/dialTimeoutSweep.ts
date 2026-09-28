/**
 * The dial-connect timeout sweep, per explicit request: "if the calls are
 * stuck for 1m 20 seconds dispose it off unless and until it's really
 * having conversations... don't keep calls occupied for 10 mins in Live
 * Monitor."
 *
 * Deliberately separate from services/callReconciliation.ts (which asks
 * the provider before ever touching a call, and never acts faster than a
 * 10-minute threshold on a 5-minute tick) - this is a narrower, much
 * faster, and unambiguous rule: a call that has NEVER connected to
 * anything at all (no answered_at - not a human, not a machine, not
 * voicemail) has no "conversation" to protect. A real phone dial resolves
 * (answers, no-answer, busy, rejected) within seconds in every normal
 * case; DIAL_TIMEOUT_MS is a generous upper bound on top of that, not a
 * guess about whether a live call is still in progress. Once a call HAS
 * connected (answered_at is set - 'answered'/'in_progress'), this sweep
 * never touches it - that is exactly the "really having conversations"
 * case, and callReconciliation's own provider-confirmed path (never
 * guessing) is what governs those instead.
 *
 * Only ever transitions through the real state machine
 * (transitionCallState()) - never a raw status write - so disposition,
 * the campaign_leads update, and Live Monitor's push notification all
 * fire exactly the way a real webhook-driven failure would.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { transitionCallState } from '../lib/callStateMachine.js';
import { resolveProviderForCall } from '../lib/orchestration/resolveProvider.js';
import { OrchestrationProviderError, OrchestrationProviderNotConfiguredError } from '../lib/orchestration/index.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Actually terminates the call at the provider (Vapi/pipecat) before
 * disposing it locally - per explicit request ("end the call without
 * wasting any more credits"). Without this, a call this sweep force-fails
 * locally keeps ringing/dialing at the provider for real, still consuming
 * minutes/credits, and can even connect a moment later with nobody on our
 * end listening for it. Mirrors routes/liveMonitor.ts's supervisor
 * "End call" action exactly: a provider error here (already ended, not
 * configured, unreachable) is never fatal to the local disposition below -
 * the local state machine transition is what actually matters and always
 * still runs. */
async function endCallAtProvider(supabase: Supabase, call: Record<string, any>): Promise<void> {
  const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
  if (!providerCallId) return;
  try {
    const provider = await resolveProviderForCall(supabase, call);
    await provider.endCall(providerCallId);
  } catch (err) {
    if (!(err instanceof OrchestrationProviderError) && !(err instanceof OrchestrationProviderNotConfiguredError)) {
      // eslint-disable-next-line no-console
      console.error('dialTimeoutSweep: endCall() at provider failed for call', call.id, err);
    }
  }
}

/** Only genuinely pre-connection statuses - a call here has never reached
 * a human, a machine, or voicemail. Deliberately NOT the full
 * ACTIVE_CALL_STATUSES list (campaignDispatcher.ts) - 'answered',
 * 'in_progress', 'voicemail', 'answering_machine', 'transfer_pending',
 * 'transferring' all mean the call connected to something and are never
 * touched here. */
const PRE_CONNECT_STATUSES = ['queued', 'dialing', 'ringing'];

const DIAL_TIMEOUT_MS = Number.parseInt(process.env.CALL_DIAL_TIMEOUT_MS ?? '', 10) || 80 * 1000;
/** Frequent by design - the whole point is a call stuck before ever
 * connecting shows up and clears within about a minute and a half, not
 * the 10+ minutes callReconciliation's own slower, providerconfirmed path
 * allows for a genuinely ambiguous case. */
const SWEEP_INTERVAL_MS = Number.parseInt(process.env.CALL_DIAL_TIMEOUT_SWEEP_INTERVAL_MS ?? '', 10) || 15 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export interface DialTimeoutSweepResult {
  checked: number;
  disposed: number;
}

/** One sweep across every organization - never throws. */
export async function runDialTimeoutSweep(): Promise<DialTimeoutSweepResult> {
  const supabase = getSupabaseAdmin();
  const result: DialTimeoutSweepResult = { checked: 0, disposed: 0 };
  const cutoff = new Date(Date.now() - DIAL_TIMEOUT_MS).toISOString();

  const { data: staleCalls } = await supabase
    .from('calls')
    .select('id, organization_id, engine, vapi_call_id, pipecat_call_id, status, created_at')
    .in('status', PRE_CONNECT_STATUSES)
    .is('answered_at', null)
    .lte('created_at', cutoff)
    .limit(500);

  const rows: Record<string, any>[] = staleCalls ?? [];
  result.checked = rows.length;

  for (const call of rows) {
    try {
      await endCallAtProvider(supabase, call);
      const applied = await transitionCallState(supabase, call.id, 'failed', {
        ended_at: new Date().toISOString(),
        ended_reason: 'dial_timeout',
      });
      if (applied.applied) result.disposed += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('dialTimeoutSweep: failed to dispose call', call.id, err);
    }
  }

  return result;
}

function runTickOnce(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  runDialTimeoutSweep()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('dialTimeoutSweep: tick failed', err);
    })
    .finally(() => {
      tickInFlight = false;
    });
}

/** Runs one tick immediately at boot (same "don't wait out a full
 * interval after every restart" lesson as callReconciliation.ts's own
 * boot-tick fix), then on SWEEP_INTERVAL_MS after that. */
export function startDialTimeoutSweep(): void {
  if (intervalHandle) return;
  runTickOnce();
  intervalHandle = setInterval(runTickOnce, SWEEP_INTERVAL_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopDialTimeoutSweep(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
