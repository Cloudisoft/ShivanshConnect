/**
 * Phase 10: builds the Live Monitor's `LiveMonitorActiveCall` projection -
 * the same batched-`IN (...)` join pattern services/cdrQuery.ts's
 * buildCdrRows() already established (never one query per call).
 * Reused both for the initial WS snapshot (ws/liveMonitor.ts) and for
 * turning a single `calls` row from a state-machine transition event into
 * the shape pushed on every subsequent WS event.
 */
import { LIVE_MONITOR_ACTIVE_STATUSES, type LiveMonitorActiveCall } from '@shivanshconnect/shared';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

function uniq<T>(values: (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}

/** Joins a small batch of raw `calls` rows (already known to be for ONE
 * organization) into LiveMonitorActiveCall projections. */
export async function buildLiveMonitorActiveCalls(supabase: Supabase, calls: Record<string, any>[]): Promise<LiveMonitorActiveCall[]> {
  if (calls.length === 0) return [];

  const campaignIds = uniq(calls.map((c) => c.campaign_id));
  const leadIds = uniq(calls.map((c) => c.lead_id));
  const agentIds = uniq(calls.map((c) => c.ai_agent_id));
  const agentVersionIds = uniq(calls.map((c) => c.ai_agent_version_id));

  const [{ data: campaigns }, { data: leads }, { data: agents }, { data: agentVersions }] = await Promise.all([
    campaignIds.length ? supabase.from('campaigns').select('id, name').in('id', campaignIds) : Promise.resolve({ data: [] as any[] }),
    leadIds.length ? supabase.from('leads').select('id, first_name, last_name').in('id', leadIds) : Promise.resolve({ data: [] as any[] }),
    agentIds.length ? supabase.from('ai_agents').select('id, name').in('id', agentIds) : Promise.resolve({ data: [] as any[] }),
    agentVersionIds.length ? supabase.from('ai_agent_versions').select('id, voice_id').in('id', agentVersionIds) : Promise.resolve({ data: [] as any[] }),
  ]);

  const campaignById = new Map((campaigns ?? []).map((c: any) => [c.id, c]));
  const leadById = new Map((leads ?? []).map((l: any) => [l.id, l]));
  const agentById = new Map((agents ?? []).map((a: any) => [a.id, a]));
  const versionById = new Map((agentVersions ?? []).map((v: any) => [v.id, v]));

  const voiceIds = uniq([...versionById.values()].map((v: any) => v.voice_id));
  const { data: voices } = voiceIds.length
    ? await supabase.from('voices').select('id, name').in('id', voiceIds)
    : { data: [] as any[] };
  const voiceById = new Map((voices ?? []).map((v: any) => [v.id, v]));

  return calls.map((call): LiveMonitorActiveCall => {
    const campaign = call.campaign_id ? campaignById.get(call.campaign_id) : null;
    const lead = call.lead_id ? leadById.get(call.lead_id) : null;
    const agent = call.ai_agent_id ? agentById.get(call.ai_agent_id) : null;
    const version = call.ai_agent_version_id ? versionById.get(call.ai_agent_version_id) : null;
    const voice = version?.voice_id ? voiceById.get(version.voice_id) : null;

    return {
      id: call.id,
      organization_id: call.organization_id,
      engine: call.engine,
      status: call.status,
      direction: call.direction,
      customer_number: call.customer_number,
      started_at: call.started_at ?? null,
      answered_at: call.answered_at ?? null,
      campaign_id: call.campaign_id ?? null,
      campaign_name: campaign?.name ?? null,
      lead_id: call.lead_id ?? null,
      lead_name: lead ? `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || null : null,
      ai_agent_id: call.ai_agent_id ?? null,
      ai_agent_name: agent?.name ?? null,
      voice_id: version?.voice_id ?? null,
      voice_name: voice?.name ?? null,
      transfer_destination_e164: call.transfer_destination_e164 ?? null,
    };
  });
}

/** The WS connection's opening snapshot: every currently-active call for
 * this organization, per LIVE_MONITOR_ACTIVE_STATUSES. */
export async function fetchActiveCallsSnapshot(supabase: Supabase, organizationId: string): Promise<LiveMonitorActiveCall[]> {
  const { data, error } = await supabase
    .from('calls')
    .select(
      'id, organization_id, engine, status, direction, customer_number, started_at, answered_at, campaign_id, lead_id, ai_agent_id, ai_agent_version_id, transfer_destination_e164',
    )
    .eq('organization_id', organizationId)
    .in('status', [...LIVE_MONITOR_ACTIVE_STATUSES]);
  if (error) throw error;
  return buildLiveMonitorActiveCalls(supabase, data ?? []);
}
