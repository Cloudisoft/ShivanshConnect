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

/** Reconciles every stuck call for ONE organization. Never throws - a
 * per-call or per-provider failure (e.g. the org's Vapi credentials were
 * since removed, or the provider is briefly unreachable) is logged and
 * that call is left untouched, so one broken org/call never stalls
 * reconciliation for every other one. */
export async function reconcileOrganizationCalls(supabase: Supabase, organizationId: string, stuckBefore: string): Promise<ReconcileResult> {
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
    try {
      if (call.engine === 'vapi') {
        if (!call.vapi_call_id || !vapiApiKey) {
          result.skipped += 1;
          continue;
        }
        const provider = createOrchestrationProvider('vapi', { api_key: vapiApiKey });
        const { raw } = await provider.getCall(call.vapi_call_id);
        const transition = vapiTerminalTransition(raw);
        if (!transition) {
          result.stillActive += 1;
          continue;
        }
        const applied = await transitionCallState(supabase, call.id, transition.status, transition.context);
        if (applied.applied) result.repaired += 1;
        else result.skipped += 1;
      } else if (call.engine === 'pipecat') {
        if (!call.pipecat_call_id) {
          result.skipped += 1;
          continue;
        }
        const provider = createOrchestrationProvider('pipecat');
        const { raw } = await provider.getCall(call.pipecat_call_id);
        const transition = pipecatTerminalTransition(raw);
        if (!transition) {
          result.stillActive += 1;
          continue;
        }
        const applied = await transitionCallState(supabase, call.id, transition.status, transition.context);
        if (applied.applied) result.repaired += 1;
        else result.skipped += 1;
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      // A provider that's unreachable, unconfigured, or errors on this
      // one call must never corrupt local state - skip and let the next
      // tick try again.
      result.skipped += 1;
      if (!(err instanceof OrchestrationProviderNotConfiguredError) && !(err instanceof OrchestrationProviderError)) {
        // eslint-disable-next-line no-console
        console.error('callReconciliation: getCall() failed for call', call.id, err);
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

  const { data: stuckOrgRows } = await supabase.from('calls').select('organization_id').in('status', ACTIVE_CALL_STATUSES).lte('created_at', stuckBefore).limit(1000);
  const organizationIds = [...new Set((stuckOrgRows ?? []).map((r: any) => r.organization_id as string))];

  for (const organizationId of organizationIds) {
    try {
      await reconcileOrganizationCalls(supabase, organizationId, stuckBefore);
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

export function startCallReconciliation(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
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
  }, RECONCILIATION_TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopCallReconciliation(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
