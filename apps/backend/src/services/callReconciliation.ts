/**
 * Phase 15: the call-state reconciliation job (master spec section 73).
 *
 * No prior phase built this - Phase 6-8 rely entirely on webhook delivery
 * to drive `calls.status` forward, which is correct the overwhelming
 * majority of the time but has one real gap: if a webhook is ever lost
 * outright (never delivered at all, as opposed to delayed - Phase 6's
 * idempotency/ordering guarantees only cover deliveries that DO arrive),
 * a call can be stuck in a non-terminal status (`dialing`/`ringing`/
 * `in_progress`/...) forever, with the orchestration engine itself having
 * long since ended it. This job is the safety net: periodically, it finds
 * calls that have been non-terminal for longer than a reasonable timeout,
 * asks the ACTUAL orchestration provider (Vapi/pipecat) what that call's
 * real current status is via `getCall()`, and - only when the provider
 * confirms the call has actually ended - repairs local state by going
 * through the real state machine (`transitionCallState()`), exactly the
 * way a webhook would have. It NEVER bypasses the state machine, and it
 * NEVER guesses: a provider it can't reach, or a call the provider still
 * reports as active, is left completely alone.
 *
 * Same in-process `setInterval` pattern every other Phase 7/12/13
 * scheduler in this codebase already uses (see campaignDispatcher.ts's
 * header comment for why, and its documented BullMQ migration path) -
 * `runReconciliationTick()` is what a real repeatable job would call
 * instead of this module's own timer.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { transitionCallState } from '../lib/callStateMachine.js';
import { ACTIVE_CALL_STATUSES } from './campaignDispatcher.js';
import { createOrchestrationProvider, OrchestrationProviderError, OrchestrationProviderNotConfiguredError } from '../lib/orchestration/index.js';
import { decryptCredentials, type EncryptedEnvelope } from '../lib/crypto/credentials.js';
import type { CallStatus } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const RECONCILIATION_TICK_MS = Number.parseInt(process.env.CALL_RECONCILIATION_INTERVAL_MS ?? '', 10) || 5 * 60 * 1000;
/** How long a call may sit in a non-terminal status before this job even
 * considers it "stuck" - deliberately generous (spec 73 suggests "a
 * reasonable timeout", ~10 minutes by default) so a genuinely still-
 * ringing/in-progress call is never mistakenly probed as if something had
 * gone wrong. */
const STUCK_CALL_TIMEOUT_MS = Number.parseInt(process.env.CALL_RECONCILIATION_STUCK_TIMEOUT_MS ?? '', 10) || 10 * 60 * 1000;
/** The force-fail cutoff (see forceFailHardStuckCall()'s doc comment) -
 * deliberately far past STUCK_CALL_TIMEOUT_MS so the provider-confirmed
 * path gets many ticks' worth of chances first (at the default 5-minute
 * tick interval, roughly 7-8 more attempts) before anything is ever
 * force-failed without the provider's confirmation. No real outbound call
 * legitimately runs this long. */
const HARD_STUCK_CALL_TIMEOUT_MS = Number.parseInt(process.env.CALL_RECONCILIATION_HARD_STUCK_TIMEOUT_MS ?? '', 10) || 45 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** Maps a Vapi `getCall()` raw response to the local terminal transition
 * it implies - mirrors routes/webhooks.ts's own 'end-of-call-report'
 * mapping exactly (never a second, drifting copy of that logic's
 * decisions), returning null when Vapi does NOT report the call as
 * ended (still genuinely active - leave it alone). */
function vapiTerminalTransition(raw: Record<string, unknown>): { status: CallStatus; context: Record<string, unknown> } | null {
  if (raw.status !== 'ended') return null;
  const endedReason = typeof raw.endedReason === 'string' ? raw.endedReason : null;
  const status: CallStatus = endedReason === 'assistant-forwarded-call' ? 'transferred' : 'completed';
  // Bug fix: this used to omit duration_seconds entirely (unlike
  // routes/webhooks.ts's own end-of-call-report handler, which always
  // sets it from Vapi's durationSeconds field) - every call repaired by
  // this reconciliation path instead of a real webhook was left with a
  // null duration, which the disposition engine (services/
  // dispositionEngine.ts) reads as "no meaningful interaction", silently
  // misclassifying real, successfully connected calls as
  // DISCONNECTED/HUNG_UP. Vapi's getCall() doesn't expose durationSeconds
  // directly, but does give real startedAt/endedAt timestamps - derived
  // the same way any duration would be from a start/end pair.
  const startedAt = typeof raw.startedAt === 'string' ? Date.parse(raw.startedAt) : NaN;
  const endedAt = typeof raw.endedAt === 'string' ? Date.parse(raw.endedAt) : NaN;
  const durationSeconds = Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt ? Math.round((endedAt - startedAt) / 1000) : null;
  return {
    status,
    context: {
      ended_at: typeof raw.endedAt === 'string' ? raw.endedAt : new Date().toISOString(),
      ended_reason: endedReason,
      duration_seconds: durationSeconds,
      cost: typeof raw.cost === 'number' ? raw.cost : null,
    },
  };
}

/** Maps a pipecat `getCall()` raw response the same way - pipecat's own
 * status vocabulary already matches our internal CallStatus names (see
 * routes/webhooks.ts's pipecat receiver map), so a terminal value passes
 * straight through. */
function pipecatTerminalTransition(raw: Record<string, unknown>): { status: CallStatus; context: Record<string, unknown> } | null {
  const status = typeof raw.status === 'string' ? raw.status : '';
  if (!['completed', 'failed', 'transferred'].includes(status)) return null;
  return {
    status: status as CallStatus,
    context: {
      ended_at: typeof raw.ended_at === 'string' ? raw.ended_at : new Date().toISOString(),
      ended_reason: typeof raw.ended_reason === 'string' ? raw.ended_reason : null,
    },
  };
}

export interface ReconcileResult {
  checked: number;
  repaired: number;
  stillActive: number;
  skipped: number;
}

/** Forces one call straight to 'failed' when it's been non-terminal for
 * far longer than any real call plausibly runs, REGARDLESS of what the
 * provider reports (or whether it could be reached at all) - the one
 * exception to this module's own "never guess" rule (see header comment),
 * deliberately reserved for this one case: a real production incident
 * where 5+ calls sat stuck in Dialing/In Progress for 17+ minutes,
 * permanently occupying their campaign's concurrency slots and silently
 * blocking every new dial ("calls have stopped working even though the
 * campaign is active") - Vapi itself was still reporting them active (or
 * unreachable) on every reconciliation pass, so the provider-confirmed
 * path alone could never clear them, and nothing else in this codebase
 * ever frees a concurrency slot except a terminal call status. Gated by
 * HARD_STUCK_CALL_TIMEOUT_MS below - deliberately much longer than
 * STUCK_CALL_TIMEOUT_MS so the polite, provider-confirmed path above gets
 * many ticks' worth of chances first. */
async function forceFailHardStuckCall(supabase: Supabase, callId: string): Promise<boolean> {
  const applied = await transitionCallState(supabase, callId, 'failed', {
    ended_at: new Date().toISOString(),
    ended_reason: 'reconciliation_hard_timeout',
  });
  return applied.applied;
}

/** Reconciles every stuck call for ONE organization. Never throws - a
 * per-call or per-provider failure (e.g. the org's Vapi credentials were
 * since removed, or the provider is briefly unreachable) is logged and
 * that call is left untouched, so one broken org/call never stalls
 * reconciliation for every other one. `hardStuckBefore` (omit to disable)
 * is the force-fail cutoff from forceFailHardStuckCall() above - a call
 * older than this that the provider-confirmed path didn't repair is
 * force-failed instead of left stuck forever. */
export async function reconcileOrganizationCalls(
  supabase: Supabase,
  organizationId: string,
  stuckBefore: string,
  hardStuckBefore?: string,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, repaired: 0, stillActive: 0, skipped: 0 };

  const { data: stuckCalls } = await supabase
    .from('calls')
    .select('id, engine, vapi_call_id, pipecat_call_id, status, created_at')
    .eq('organization_id', organizationId)
    .in('status', ACTIVE_CALL_STATUSES)
    .lte('created_at', stuckBefore)
    .limit(200);

  const rows: Record<string, any>[] = stuckCalls ?? [];
  result.checked = rows.length;
  if (rows.length === 0) return result;

  let vapiApiKey: string | null = null;
  const vapiCalls = rows.filter((c) => c.engine === 'vapi');
  if (vapiCalls.length > 0) {
    const { data: credRow } = await supabase.from('vapi_credentials').select('encrypted_credentials').eq('organization_id', organizationId).maybeSingle();
    if (credRow) {
      try {
        vapiApiKey = decryptCredentials<{ api_key: string }>(credRow.encrypted_credentials as EncryptedEnvelope).api_key;
      } catch {
        vapiApiKey = null;
      }
    }
  }

  for (const call of rows) {
    // Tracks exactly which counter THIS call was counted under below, so
    // the hard-timeout fallback can correctly move it to `repaired`
    // instead of blindly decrementing a shared counter that could belong
    // to a different call entirely.
    let countedAs: 'repaired' | 'stillActive' | 'skipped' = 'skipped';
    try {
      if (call.engine === 'vapi') {
        if (!call.vapi_call_id || !vapiApiKey) {
          result.skipped += 1;
        } else {
          const provider = createOrchestrationProvider('vapi', { api_key: vapiApiKey });
          const { raw } = await provider.getCall(call.vapi_call_id);
          const transition = vapiTerminalTransition(raw);
          if (!transition) {
            result.stillActive += 1;
            countedAs = 'stillActive';
          } else {
            const applied = await transitionCallState(supabase, call.id, transition.status, transition.context);
            if (applied.applied) {
              result.repaired += 1;
              countedAs = 'repaired';
            } else {
              result.skipped += 1;
            }
          }
        }
      } else if (call.engine === 'pipecat') {
        if (!call.pipecat_call_id) {
          result.skipped += 1;
        } else {
          const provider = createOrchestrationProvider('pipecat');
          const { raw } = await provider.getCall(call.pipecat_call_id);
          const transition = pipecatTerminalTransition(raw);
          if (!transition) {
            result.stillActive += 1;
            countedAs = 'stillActive';
          } else {
            const applied = await transitionCallState(supabase, call.id, transition.status, transition.context);
            if (applied.applied) {
              result.repaired += 1;
              countedAs = 'repaired';
            } else {
              result.skipped += 1;
            }
          }
        }
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      // A provider that's unreachable, unconfigured, or errors on this
      // one call must never corrupt local state via a WRONG guess - but
      // see the hard-timeout fallback below, which still applies here.
      result.skipped += 1;
      if (!(err instanceof OrchestrationProviderNotConfiguredError) && !(err instanceof OrchestrationProviderError)) {
        // eslint-disable-next-line no-console
        console.error('callReconciliation: getCall() failed for call', call.id, err);
      }
    }

    if (countedAs !== 'repaired' && hardStuckBefore && call.created_at <= hardStuckBefore) {
      try {
        const forced = await forceFailHardStuckCall(supabase, call.id);
        if (forced) {
          if (countedAs === 'stillActive') result.stillActive -= 1;
          else result.skipped -= 1;
          result.repaired += 1;
          // eslint-disable-next-line no-console
          console.error('callReconciliation: force-failed a hard-stuck call after exceeding the hard timeout', call.id, { engine: call.engine, created_at: call.created_at });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('callReconciliation: force-fail itself failed for call', call.id, err);
      }
    }
  }

  return result;
}

/** Runs one full reconciliation tick across every organization that
 * currently has at least one stuck call. Never throws. */
export async function runReconciliationTick(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const stuckBefore = new Date(Date.now() - STUCK_CALL_TIMEOUT_MS).toISOString();
  const hardStuckBefore = new Date(Date.now() - HARD_STUCK_CALL_TIMEOUT_MS).toISOString();

  const { data: stuckOrgRows } = await supabase.from('calls').select('organization_id').in('status', ACTIVE_CALL_STATUSES).lte('created_at', stuckBefore).limit(1000);
  const organizationIds = [...new Set((stuckOrgRows ?? []).map((r: any) => r.organization_id as string))];

  for (const organizationId of organizationIds) {
    try {
      await reconcileOrganizationCalls(supabase, organizationId, stuckBefore, hardStuckBefore);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('callReconciliation: tick failed for organization', organizationId, err);
    }
  }
}

let lastTickAt: string | null = null;

/** Timestamp of the last completed tick (successful or not) - surfaced by
 * `GET /admin/health` so staleness is visible (see routes/admin.ts). */
export function getLastReconciliationTickAt(): string | null {
  return lastTickAt;
}

function runTickOnce(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  runReconciliationTick()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('callReconciliation: tick failed', err);
    })
    .finally(() => {
      lastTickAt = new Date().toISOString();
      tickInFlight = false;
    });
}

export function startCallReconciliation(): void {
  if (intervalHandle) return;
  // Bug: setInterval's callback only ever fires after the FIRST full
  // RECONCILIATION_TICK_MS (5 min) elapses - it never ran once at boot.
  // Combined with STUCK_CALL_TIMEOUT_MS (10 min) and this process
  // restarting on every deploy, a stuck call could sit unrepaired,
  // visibly frozen in Live Monitor, for a long time after any restart
  // before the safety net got its first real chance to run at all. Now
  // also runs once immediately on startup, same "fire-and-forget, self-
  // limiting" pattern as callEndDataRepair.ts's boot-time repair.
  runTickOnce();
  intervalHandle = setInterval(runTickOnce, RECONCILIATION_TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopCallReconciliation(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
