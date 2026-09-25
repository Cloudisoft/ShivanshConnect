/**
 * Phase 9: the ONE query-building module both `GET /cdr` (routes/cdr.ts)
 * and the background export job (services/cdrExport.ts) use - the export
 * must run against exactly the same filtered result set the list endpoint
 * would show, never a second, independently-drifting derivation.
 *
 * Real server-side pagination throughout (spec section 55): the list
 * route pages via `fetchCdrCallsPage()`; the export job streams through
 * every matching page via `iterateAllCdrRows()` rather than ever loading
 * the full result set into memory at once.
 */
import type { CdrRow } from '@shivanshconnect/shared';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface CdrFilters {
  date_from?: string;
  date_to?: string;
  campaign_id?: string;
  ai_agent_id?: string;
  disposition?: string;
  phone?: string;
  lead_id?: string;
  status?: string;
}

const CALL_COLUMNS =
  'id, organization_id, engine, vapi_call_id, pipecat_call_id, ai_agent_id, ai_agent_version_id, campaign_id, lead_id, phone_number_id, voice_id, direction, customer_number, status, started_at, answered_at, ended_at, duration_seconds, talk_duration_seconds, ended_reason, transfer_status, cost, created_at';

/** Resolves `filters.disposition` (a disposition CODE or NAME, org-scoped
 * plus system defaults) to the exact set of call ids carrying it. Returns
 * null when no disposition filter was requested (meaning "don't filter by
 * disposition at all"), and an empty array when the filter matched no
 * disposition or no calls - both cases the caller short-circuits to an
 * empty page rather than running an unbounded query. */
async function resolveCallIdsForDispositionFilter(supabase: Supabase, orgId: string, disposition: string | undefined): Promise<string[] | null> {
  if (!disposition) return null;
  const needle = disposition.trim().toLowerCase();

  const { data: dispositionRows } = await supabase.from('dispositions').select('id, code, name, organization_id').or(`organization_id.is.null,organization_id.eq.${orgId}`);
  const matchingIds = (dispositionRows ?? [])
    .filter((d: any) => d.code.toLowerCase() === needle || d.name.toLowerCase() === needle)
    .map((d: any) => d.id);
  if (matchingIds.length === 0) return [];

  const { data: callDispositions } = await supabase.from('call_dispositions').select('call_id').eq('organization_id', orgId).in('disposition_id', matchingIds);
  return (callDispositions ?? []).map((cd: any) => cd.call_id);
}

/** Applies every filter EXCEPT the disposition one (that needs the async
 * pre-resolution above) to a base `calls` query builder. */
function applyCommonFilters(builder: any, orgId: string, filters: CdrFilters): any {
  let b = builder.eq('organization_id', orgId);
  if (filters.date_from) b = b.gte('created_at', filters.date_from);
  if (filters.date_to) b = b.lte('created_at', filters.date_to);
  if (filters.campaign_id) b = b.eq('campaign_id', filters.campaign_id);
  if (filters.ai_agent_id) b = b.eq('ai_agent_id', filters.ai_agent_id);
  if (filters.lead_id) b = b.eq('lead_id', filters.lead_id);
  if (filters.status) b = b.eq('status', filters.status);
  if (filters.phone) b = b.ilike('customer_number', `%${filters.phone}%`);
  return b;
}

export interface CdrCallsPage {
  calls: Record<string, any>[];
  count: number;
}

/** Fetches ONE page of raw `calls` rows matching the given filters,
 * newest first - the only place a `calls` row is read for CDR purposes.
 * Never fetches more than `pageSize` rows. */
export async function fetchCdrCallsPage(supabase: Supabase, orgId: string, filters: CdrFilters, page: number, pageSize: number): Promise<CdrCallsPage> {
  const dispositionCallIds = await resolveCallIdsForDispositionFilter(supabase, orgId, filters.disposition);
  if (dispositionCallIds !== null && dispositionCallIds.length === 0) return { calls: [], count: 0 };

  let builder = supabase.from('calls').select(CALL_COLUMNS, { count: 'exact' });
  builder = applyCommonFilters(builder, orgId, filters);
  if (dispositionCallIds !== null) builder = builder.in('id', dispositionCallIds);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  builder = builder.order('created_at', { ascending: false }).range(from, to);

  const { data, error, count } = await builder;
  if (error) throw error;
  return { calls: (data as Record<string, any>[]) ?? [], count: count ?? 0 };
}

/** Streams through EVERY page of matching calls (batches of `batchSize`),
 * invoking `onPage` with each batch's already-shaped CdrRow[] - used by
 * the export job so it never holds the full result set in memory at once.
 * Returns the total row count actually streamed. */
export async function iterateAllCdrRows(
  supabase: Supabase,
  orgId: string,
  filters: CdrFilters,
  onPage: (rows: CdrRow[]) => Promise<void>,
  batchSize = 500,
): Promise<number> {
  let page = 1;
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { calls, count } = await fetchCdrCallsPage(supabase, orgId, filters, page, batchSize);
    if (calls.length === 0) break;
    // eslint-disable-next-line no-await-in-loop
    const rows = await buildCdrRows(supabase, orgId, calls);
    // eslint-disable-next-line no-await-in-loop
    await onPage(rows);
    total += rows.length;
    if (page * batchSize >= count) break;
    page += 1;
  }
  return total;
}

function uniq<T>(values: Array<T | null | undefined>): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}

/**
 * Joins a page of raw `calls` rows into full CdrRow shapes via a fixed,
 * small number of batched `IN (...)` lookups - never one query per call
 * (no N+1), regardless of page size.
 */
export async function buildCdrRows(supabase: Supabase, orgId: string, calls: Record<string, any>[]): Promise<CdrRow[]> {
  if (calls.length === 0) return [];

  const callIds = calls.map((c) => c.id);
  const campaignIds = uniq(calls.map((c) => c.campaign_id));
  const leadIds = uniq(calls.map((c) => c.lead_id));
  const agentIds = uniq(calls.map((c) => c.ai_agent_id));
  const agentVersionIds = uniq(calls.map((c) => c.ai_agent_version_id));
  const phoneNumberIds = uniq(calls.map((c) => c.phone_number_id));

  const [
    { data: dispositions },
    { data: allDispositionDefs },
    { data: campaigns },
    { data: leads },
    { data: agents },
    { data: agentVersions },
    { data: phoneNumbers },
    { data: transcripts },
    { data: recordings },
    { data: summaries },
  ] = await Promise.all([
    supabase.from('call_dispositions').select('call_id, disposition_id').in('call_id', callIds),
    supabase.from('dispositions').select('id, code, name'),
    campaignIds.length ? supabase.from('campaigns').select('id, name').in('id', campaignIds) : Promise.resolve({ data: [] }),
    leadIds.length ? supabase.from('leads').select('id, first_name, last_name').in('id', leadIds) : Promise.resolve({ data: [] }),
    agentIds.length ? supabase.from('ai_agents').select('id, name').in('id', agentIds) : Promise.resolve({ data: [] }),
    agentVersionIds.length ? supabase.from('ai_agent_versions').select('id, voice_id').in('id', agentVersionIds) : Promise.resolve({ data: [] }),
    phoneNumberIds.length ? supabase.from('phone_numbers').select('id, phone_number').in('id', phoneNumberIds) : Promise.resolve({ data: [] }),
    supabase.from('call_transcripts').select('call_id, status').in('call_id', callIds),
    supabase.from('call_recordings').select('call_id, status').in('call_id', callIds),
    supabase.from('call_summaries').select('call_id').in('call_id', callIds),
  ]);

  const dispositionDefById = new Map((allDispositionDefs ?? []).map((d: any) => [d.id, d]));
  const dispositionByCallId = new Map((dispositions ?? []).map((cd: any) => [cd.call_id, dispositionDefById.get(cd.disposition_id) ?? null]));
  const campaignById = new Map((campaigns ?? []).map((c: any) => [c.id, c]));
  const leadById = new Map((leads ?? []).map((l: any) => [l.id, l]));
  const agentById = new Map((agents ?? []).map((a: any) => [a.id, a]));
  const versionById = new Map((agentVersions ?? []).map((v: any) => [v.id, v]));
  const phoneNumberById = new Map((phoneNumbers ?? []).map((p: any) => [p.id, p]));
  const transcriptReadyByCallId = new Set((transcripts ?? []).filter((t: any) => t.status === 'ready').map((t: any) => t.call_id));
  const recordingReadyByCallId = new Set((recordings ?? []).filter((r: any) => r.status === 'ready').map((r: any) => r.call_id));
  const summaryByCallId = new Set((summaries ?? []).map((s: any) => s.call_id));

  // The voice actually used for a call (a campaign override, most
  // often) lives on calls.voice_id itself, NOT the agent version's own
  // default - re-deriving it from the version was the bug ("Live
  // Monitor/CDR still shows Tina instead of Mitchell"): it can only
  // show the agent's default, wrong whenever a campaign's own voice
  // overrides it. A call placed before that column existed falls back
  // to the version's default, the best available answer for those
  // older rows only.
  const versionVoiceIds = uniq([...versionById.values()].map((v: any) => v.voice_id));
  const callVoiceIds = uniq(calls.map((c) => c.voice_id));
  const voiceIds = uniq([...versionVoiceIds, ...callVoiceIds]);
  const { data: voices } = voiceIds.length
    ? await supabase.from('voices').select('id, name').in('id', voiceIds)
    : { data: [] as any[] };
  const voiceById = new Map((voices ?? []).map((v: any) => [v.id, v]));

  return calls.map((call) => {
    const disposition = dispositionByCallId.get(call.id) ?? null;
    const campaign = call.campaign_id ? campaignById.get(call.campaign_id) : null;
    const lead = call.lead_id ? leadById.get(call.lead_id) : null;
    const agent = agentById.get(call.ai_agent_id);
    const version = versionById.get(call.ai_agent_version_id);
    const resolvedVoiceId = call.voice_id ?? version?.voice_id ?? null;
    const voice = resolvedVoiceId ? voiceById.get(resolvedVoiceId) : null;
    const phoneNumber = phoneNumberById.get(call.phone_number_id);

    const row: CdrRow = {
      call_id: call.id,
      provider_call_id: call.vapi_call_id ?? call.pipecat_call_id ?? null,
      campaign_id: call.campaign_id ?? null,
      campaign_name: campaign?.name ?? null,
      lead_id: call.lead_id ?? null,
      lead_name: lead ? `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || null : null,
      caller_number: phoneNumber?.phone_number ?? '',
      destination_number: call.customer_number,
      direction: call.direction,
      ai_agent_id: call.ai_agent_id,
      ai_agent_name: agent?.name ?? null,
      voice_id: resolvedVoiceId,
      voice_name: voice?.name ?? null,
      started_at: call.started_at,
      answered_at: call.answered_at,
      ended_at: call.ended_at,
      duration_seconds: call.duration_seconds,
      talk_duration_seconds: call.talk_duration_seconds,
      status: call.status,
      disposition_code: disposition?.code ?? null,
      disposition_name: disposition?.name ?? null,
      ended_reason: call.ended_reason,
      transfer_status: call.transfer_status,
      has_recording: recordingReadyByCallId.has(call.id),
      has_transcript: transcriptReadyByCallId.has(call.id),
      has_summary: summaryByCallId.has(call.id),
      cost: call.cost,
      engine: call.engine,
      created_at: call.created_at,
    };
    return row;
  });
}
