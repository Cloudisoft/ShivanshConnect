/**
 * One-off/startup repair for a real historical data-corruption bug in
 * routes/webhooks.ts's 'status-update' handler: it used to map Vapi's
 * status-update `status: 'ended'` straight to `calls.status = 'completed'`
 * with NO end-of-call data attached. When that status-update arrived
 * before the later end-of-call-report for the same call (a real, common
 * Vapi delivery order - end-of-call-report needs post-processing time),
 * the call was already 'completed' by the time end-of-call-report
 * arrived, and transitionCallState() treats a same-status transition as a
 * no-op - so end-of-call-report's real ended_at/duration_seconds/cost
 * were silently discarded forever. Every affected call is stuck showing
 * a blank End Time and Duration in CDR permanently, with no webhook ever
 * going to arrive again to fix it.
 *
 * This is NOT a state transition (the call's status never changes here,
 * it is already terminal) - it is a direct column repair, which is why
 * it does not go through transitionCallState() the way every real status
 * change must. Unlike services/callReconciliation.ts (which repairs
 * calls stuck NON-terminal by asking the provider for current status),
 * this repairs calls that ARE already terminal but missing the data a
 * webhook should have attached - a genuinely different failure mode.
 *
 * Also re-runs the disposition engine for each repaired call: with
 * duration_seconds null, decideDisposition() couldn't tell a real
 * connected call from a bare hang-up, so some of these calls may carry
 * an incorrect engine-assigned disposition alongside their blank end
 * data. assignDispositionForCall() itself never overwrites a manual
 * override, so this is always safe to re-run.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { createOrchestrationProvider, OrchestrationProviderError, OrchestrationProviderNotConfiguredError } from '../lib/orchestration/index.js';
import { decryptCredentials, type EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { assignDispositionForCall } from './dispositionEngine.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface RepairResult {
  checked: number;
  repaired: number;
  skipped: number;
}

/** Mirrors callReconciliation.ts's vapiTerminalTransition() derivation of
 * duration from startedAt/endedAt - Vapi's getCall() doesn't expose
 * durationSeconds directly. */
function deriveEndData(raw: Record<string, unknown>): { ended_at: string | null; ended_reason: string | null; duration_seconds: number | null; cost: number | null } {
  const startedAt = typeof raw.startedAt === 'string' ? Date.parse(raw.startedAt) : NaN;
  const endedAt = typeof raw.endedAt === 'string' ? Date.parse(raw.endedAt) : NaN;
  const duration_seconds = Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt ? Math.round((endedAt - startedAt) / 1000) : null;
  return {
    ended_at: typeof raw.endedAt === 'string' ? raw.endedAt : null,
    ended_reason: typeof raw.endedReason === 'string' ? raw.endedReason : null,
    duration_seconds,
    cost: typeof raw.cost === 'number' ? raw.cost : null,
  };
}

/** Repairs every affected Vapi call for ONE organization. Never throws -
 * a per-call or per-provider failure is logged and that call is left
 * untouched (retried on the next run), exactly like callReconciliation.ts. */
export async function repairOrganizationCallEndData(supabase: Supabase, organizationId: string): Promise<RepairResult> {
  const result: RepairResult = { checked: 0, repaired: 0, skipped: 0 };

  const { data: rows } = await supabase
    .from('calls')
    .select('id, organization_id, engine, vapi_call_id, status')
    .eq('organization_id', organizationId)
    .in('status', ['completed', 'transferred'])
    .eq('engine', 'vapi')
    .is('ended_at', null)
    .limit(200);

  const calls: Record<string, any>[] = rows ?? [];
  result.checked = calls.length;
  if (calls.length === 0) return result;

  const { data: credRow } = await supabase.from('vapi_credentials').select('encrypted_credentials').eq('organization_id', organizationId).maybeSingle();
  if (!credRow) {
    result.skipped = calls.length;
    return result;
  }
  let apiKey: string;
  try {
    apiKey = decryptCredentials<{ api_key: string }>(credRow.encrypted_credentials as EncryptedEnvelope).api_key;
  } catch {
    result.skipped = calls.length;
    return result;
  }
  const provider = createOrchestrationProvider('vapi', { api_key: apiKey });

  for (const call of calls) {
    if (!call.vapi_call_id) {
      result.skipped += 1;
      continue;
    }
    try {
      const { raw } = await provider.getCall(call.vapi_call_id);
      const endData = deriveEndData(raw);
      if (!endData.ended_at) {
        // Vapi itself has no end data for this call either (rare) -
        // nothing to repair it with; leave it for a future retry.
        result.skipped += 1;
        continue;
      }
      const { data: updated, error } = await supabase.from('calls').update(endData).eq('id', call.id).select('*').maybeSingle();
      if (error || !updated) {
        result.skipped += 1;
        continue;
      }
      await assignDispositionForCall(supabase, updated);
      result.repaired += 1;
    } catch (err) {
      result.skipped += 1;
      if (!(err instanceof OrchestrationProviderNotConfiguredError) && !(err instanceof OrchestrationProviderError)) {
        // eslint-disable-next-line no-console
        console.error('callEndDataRepair: getCall() failed for call', call.id, err);
      }
    }
  }

  return result;
}

/** Runs the repair across every organization that currently has at least
 * one affected call. Intended to run once at process startup (see
 * index.ts) - cheap and self-limiting: once every affected historical
 * call is repaired, the query in repairOrganizationCallEndData() simply
 * returns nothing on every subsequent boot. Never throws. */
export async function runCallEndDataRepair(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: orgRows } = await supabase.from('calls').select('organization_id').in('status', ['completed', 'transferred']).eq('engine', 'vapi').is('ended_at', null).limit(1000);
  const organizationIds = [...new Set((orgRows ?? []).map((r: any) => r.organization_id as string))];

  for (const organizationId of organizationIds) {
    try {
      const result = await repairOrganizationCallEndData(supabase, organizationId);
      if (result.repaired > 0) {
        // eslint-disable-next-line no-console
        console.log(`callEndDataRepair: repaired ${result.repaired}/${result.checked} call(s) for organization ${organizationId}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('callEndDataRepair: run failed for organization', organizationId, err);
    }
  }
}
