/**
 * Phase 12: the query-building module backing routes/dashboard.ts and
 * routes/analytics.ts - mirrors Phase 9's services/cdrQuery.ts (one
 * shared module, never a second independently-drifting query path).
 *
 * Historical strategy (master spec section 89 - never scan the full
 * `calls` table for anything beyond "today"): every period's numbers for
 * dates strictly before today come from the `analytics_daily_*`/
 * `analytics_hourly_org` rollup tables (kept current by
 * services/analyticsAggregator.ts). TODAY's own contribution is always
 * computed live (a single bounded query over today's `calls` rows plus a
 * couple of small batched lookups - never the full table, just today's
 * slice of it), because the rollup's own "today" row is only as fresh as
 * the last aggregator tick (documented in analyticsAggregator.ts).
 * Genuinely real-time figures - Active Calls, Remaining Leads, Campaigns
 * Running, AI Agents Active - are ALWAYS live queries, in every period,
 * per the spec.
 *
 * All date-range math here is UTC-based (`created_at::date` in the
 * rollup functions is also UTC) - a documented simplification, same
 * category as Phase 7's fixed-delay retry math: something real ships
 * today, per-org-timezone day boundaries are a following-up refinement.
 */
import type {
  AgentAnalytics,
  AgentPerformancePoint,
  AnalyticsPeriod,
  CampaignAnalytics,
  CampaignPerformancePoint,
  ChartPoint,
  DailyMetricPoint,
  DashboardCharts,
  DashboardMetrics,
} from '@shivanshconnect/shared';
import type { getSupabaseAdmin } from '../lib/supabase.js';
import { ACTIVE_CALL_STATUSES } from './campaignDispatcher.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface ResolvedPeriod {
  period: AnalyticsPeriod;
  /** Inclusive, UTC 'YYYY-MM-DD'. */
  fromDate: string;
  /** Inclusive, UTC 'YYYY-MM-DD'. */
  toDate: string;
  fromISO: string;
  /** Exclusive upper bound - "now" when the range includes today. */
  toISO: string;
  /** True when `toDate` is today, i.e. part of the range needs a live
   * computation rather than only rollup rows. */
  includesToday: boolean;
  todayDate: string;
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export function resolvePeriod(query: { period: AnalyticsPeriod; date_from?: string; date_to?: string }): ResolvedPeriod {
  const now = new Date();
  const todayDate = utcDateStr(now);

  let fromDate: string;
  let toDate: string;
  let toISO: string;

  switch (query.period) {
    case 'today': {
      fromDate = todayDate;
      toDate = todayDate;
      toISO = now.toISOString();
      break;
    }
    case 'yesterday': {
      const y = new Date(startOfUtcDate(todayDate).getTime() - 24 * 60 * 60 * 1000);
      fromDate = utcDateStr(y);
      toDate = fromDate;
      toISO = startOfUtcDate(todayDate).toISOString();
      break;
    }
    case '7d': {
      const from = new Date(startOfUtcDate(todayDate).getTime() - 6 * 24 * 60 * 60 * 1000);
      fromDate = utcDateStr(from);
      toDate = todayDate;
      toISO = now.toISOString();
      break;
    }
    case '30d': {
      const from = new Date(startOfUtcDate(todayDate).getTime() - 29 * 24 * 60 * 60 * 1000);
      fromDate = utcDateStr(from);
      toDate = todayDate;
      toISO = now.toISOString();
      break;
    }
    case 'custom':
    default: {
      fromDate = (query.date_from ?? todayDate).slice(0, 10);
      toDate = (query.date_to ?? todayDate).slice(0, 10);
      const requestedEndExclusive = new Date(startOfUtcDate(toDate).getTime() + 24 * 60 * 60 * 1000);
      toISO = requestedEndExclusive.getTime() > now.getTime() ? now.toISOString() : requestedEndExclusive.toISOString();
      break;
    }
  }

  return {
    period: query.period,
    fromDate,
    toDate,
    fromISO: startOfUtcDate(fromDate).toISOString(),
    toISO,
    includesToday: toDate >= todayDate,
    todayDate,
  };
}

/** Every UTC date string in [fromDate, toDate], inclusive. */
function dateRange(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  let cursor = startOfUtcDate(fromDate);
  const end = startOfUtcDate(toDate);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(utcDateStr(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

/** Historical (strictly-before-today) portion of a date range - rollup
 * rows only ever cover these dates. */
function historicalDates(resolved: ResolvedPeriod): string[] {
  return dateRange(resolved.fromDate, resolved.toDate).filter((d) => d < resolved.todayDate);
}

// ---------------------------------------------------------------------
// Today's live slice - fetched once per request, reused across metrics/
// charts, never re-fetched per field.
// ---------------------------------------------------------------------

interface TodayCallRow {
  id: string;
  status: string;
  answered_at: string | null;
  duration_seconds: number | null;
  talk_duration_seconds: number | null;
  ai_agent_id: string | null;
  campaign_id: string | null;
  created_at: string;
}

async function fetchTodayCalls(supabase: Supabase, orgId: string, resolved: ResolvedPeriod): Promise<TodayCallRow[]> {
  if (!resolved.includesToday) return [];
  const { data, error } = await supabase
    .from('calls')
    .select('id, status, answered_at, duration_seconds, talk_duration_seconds, ai_agent_id, campaign_id, created_at')
    .eq('organization_id', orgId)
    .gte('created_at', startOfUtcDate(resolved.todayDate).toISOString())
    .lte('created_at', resolved.toISO);
  if (error) throw error;
  return (data as TodayCallRow[]) ?? [];
}

async function fetchDispositionCodesForCalls(supabase: Supabase, orgId: string, callIds: string[]): Promise<Map<string, string>> {
  if (callIds.length === 0) return new Map();
  const [{ data: cds }, { data: defs }] = await Promise.all([
    supabase.from('call_dispositions').select('call_id, disposition_id').eq('organization_id', orgId).in('call_id', callIds),
    supabase.from('dispositions').select('id, code'),
  ]);
  const codeById = new Map((defs ?? []).map((d: any) => [d.id, d.code]));
  return new Map((cds ?? []).map((cd: any) => [cd.call_id, codeById.get(cd.disposition_id) ?? null]));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/** Weighted mean of per-day averages, weighted by each day's call count -
 * documented approximation (see this file's header) since the rollup
 * tables store an average, not a sum, per day. */
function weightedAverage(points: Array<{ avg: number | null; weight: number }>): number | null {
  const usable = points.filter((p) => p.avg !== null && p.weight > 0);
  const totalWeight = usable.reduce((a, p) => a + p.weight, 0);
  if (totalWeight === 0) return null;
  const sum = usable.reduce((a, p) => a + (p.avg as number) * p.weight, 0);
  return Math.round((sum / totalWeight) * 100) / 100;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

// ---------------------------------------------------------------------
// Live real-time figures (spec: never rollups, in every period)
// ---------------------------------------------------------------------

export async function getLiveRealtimeCounts(supabase: Supabase, orgId: string) {
  const [{ count: activeCalls }, { count: campaignsRunning }, { count: aiAgentsActive }] = await Promise.all([
    supabase.from('calls').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).in('status', ACTIVE_CALL_STATUSES),
    supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'running'),
    supabase.from('ai_agents').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'active'),
  ]);

  const { data: runningCampaigns } = await supabase.from('campaigns').select('id').eq('organization_id', orgId).eq('status', 'running');
  const runningCampaignIds = (runningCampaigns ?? []).map((c: any) => c.id);
  let remainingLeads = 0;
  if (runningCampaignIds.length > 0) {
    const { count } = await supabase
      .from('campaign_leads')
      .select('id', { count: 'exact', head: true })
      .in('campaign_id', runningCampaignIds)
      .in('status', ['pending', 'queued', 'retry_pending']);
    remainingLeads = count ?? 0;
  }

  return {
    active_calls: activeCalls ?? 0,
    remaining_leads: remainingLeads,
    campaigns_running: campaignsRunning ?? 0,
    ai_agents_active: aiAgentsActive ?? 0,
  };
}

// ---------------------------------------------------------------------
// GET /dashboard
// ---------------------------------------------------------------------

export async function getDashboardMetrics(supabase: Supabase, orgId: string, resolved: ResolvedPeriod): Promise<DashboardMetrics> {
  const histDates = historicalDates(resolved);
  const { data: rollupRows } = histDates.length
    ? await supabase.from('analytics_daily_org').select('*').eq('organization_id', orgId).in('date', histDates)
    : { data: [] as any[] };
  const rows: any[] = rollupRows ?? [];

  const todayCalls = await fetchTodayCalls(supabase, orgId, resolved);
  const dispositionByCallId = await fetchDispositionCodesForCalls(supabase, orgId, todayCalls.map((c) => c.id));
  const { count: todayCallbacks } = resolved.includesToday
    ? await supabase
        .from('callbacks')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .gte('created_at', startOfUtcDate(resolved.todayDate).toISOString())
        .lte('created_at', resolved.toISO)
    : { count: 0 };

  const todayDurations = todayCalls.map((c) => c.duration_seconds).filter((v): v is number => v != null);
  const todayTalk = todayCalls.map((c) => c.talk_duration_seconds).filter((v): v is number => v != null);

  const todayMetrics = {
    total_calls: todayCalls.length,
    calls_connected: todayCalls.filter((c) => c.answered_at != null).length,
    calls_completed: todayCalls.filter((c) => c.status === 'completed').length,
    calls_failed: todayCalls.filter((c) => c.status === 'failed').length,
    voicemails: todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'VOICEMAIL').length,
    answering_machines: todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'ANSWERING_MACHINE').length,
    dnc: todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'DNC').length,
    not_interested: todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'NOT_INTERESTED').length,
    transfers: todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'TRANSFERRED').length,
    callbacks: todayCallbacks ?? 0,
    avg_duration: average(todayDurations),
    avg_talk: average(todayTalk),
  };

  const totalCalls = rows.reduce((a, r) => a + r.total_calls, 0) + todayMetrics.total_calls;
  const callsConnected = rows.reduce((a, r) => a + r.calls_connected, 0) + todayMetrics.calls_connected;
  const callsCompleted = rows.reduce((a, r) => a + r.calls_completed, 0) + todayMetrics.calls_completed;
  const callsFailed = rows.reduce((a, r) => a + r.calls_failed, 0) + todayMetrics.calls_failed;
  const voicemails = rows.reduce((a, r) => a + r.voicemails, 0) + todayMetrics.voicemails;
  const answeringMachines = rows.reduce((a, r) => a + r.answering_machines, 0) + todayMetrics.answering_machines;
  const dnc = rows.reduce((a, r) => a + r.dnc_count, 0) + todayMetrics.dnc;
  const notInterested = rows.reduce((a, r) => a + r.not_interested_count, 0) + todayMetrics.not_interested;
  const transfers = rows.reduce((a, r) => a + r.transfers, 0) + todayMetrics.transfers;
  const callbacks = rows.reduce((a, r) => a + r.callbacks_scheduled, 0) + todayMetrics.callbacks;

  const avgDuration = weightedAverage([
    ...rows.map((r) => ({ avg: r.avg_call_duration_seconds != null ? Number(r.avg_call_duration_seconds) : null, weight: r.total_calls })),
    { avg: todayMetrics.avg_duration, weight: todayMetrics.total_calls },
  ]);
  const avgTalk = weightedAverage([
    ...rows.map((r) => ({ avg: r.avg_talk_time_seconds != null ? Number(r.avg_talk_time_seconds) : null, weight: r.total_calls })),
    { avg: todayMetrics.avg_talk, weight: todayMetrics.total_calls },
  ]);

  const periodHours = Math.max((new Date(resolved.toISO).getTime() - new Date(resolved.fromISO).getTime()) / (1000 * 60 * 60), 1);

  const realtime = await getLiveRealtimeCounts(supabase, orgId);

  return {
    period: resolved.period,
    date_from: resolved.fromDate,
    date_to: resolved.toDate,
    total_calls: totalCalls,
    calls_connected: callsConnected,
    calls_completed: callsCompleted,
    calls_failed: callsFailed,
    voicemails,
    answering_machines: answeringMachines,
    dnc,
    not_interested: notInterested,
    transfers,
    callbacks,
    average_call_duration_seconds: avgDuration ?? 0,
    average_talk_time_seconds: avgTalk ?? 0,
    connection_rate: pct(callsConnected, totalCalls),
    transfer_rate: pct(transfers, totalCalls),
    voicemail_rate: pct(voicemails, totalCalls),
    dnc_rate: pct(dnc, totalCalls),
    calls_per_hour: Math.round((totalCalls / periodHours) * 100) / 100,
    ...realtime,
  };
}

// ---------------------------------------------------------------------
// GET /dashboard/charts
// ---------------------------------------------------------------------

export async function getDashboardCharts(supabase: Supabase, orgId: string, resolved: ResolvedPeriod): Promise<DashboardCharts> {
  const histDates = historicalDates(resolved);
  const [{ data: dailyRows }, { data: hourlyRows }, { data: campaignRows }, { data: agentRows }] = await Promise.all([
    histDates.length ? supabase.from('analytics_daily_org').select('*').eq('organization_id', orgId).in('date', histDates) : Promise.resolve({ data: [] as any[] }),
    supabase.from('analytics_hourly_org').select('*').eq('organization_id', orgId).gte('hour_bucket', resolved.fromISO).lte('hour_bucket', resolved.toISO),
    histDates.length ? supabase.from('analytics_daily_campaign').select('*').eq('organization_id', orgId).in('date', histDates) : Promise.resolve({ data: [] as any[] }),
    histDates.length ? supabase.from('analytics_daily_agent').select('*').eq('organization_id', orgId).in('date', histDates) : Promise.resolve({ data: [] as any[] }),
  ]);

  const todayCalls = await fetchTodayCalls(supabase, orgId, resolved);
  const dispositionByCallId = await fetchDispositionCodesForCalls(supabase, orgId, todayCalls.map((c) => c.id));

  // --- calls_by_day / average_duration_trend / connection_rate_trend / transfer_statistics ---
  const byDate = new Map<string, { total: number; connected: number; durations: number[]; transfers: number }>();
  for (const d of dateRange(resolved.fromDate, resolved.toDate)) byDate.set(d, { total: 0, connected: 0, durations: [], transfers: 0 });
  for (const r of dailyRows ?? []) {
    const entry = byDate.get(r.date);
    if (!entry) continue;
    entry.total += r.total_calls;
    entry.connected += r.calls_connected;
    entry.transfers += r.transfers;
    if (r.avg_call_duration_seconds != null) entry.durations.push(Number(r.avg_call_duration_seconds));
  }
  if (resolved.includesToday) {
    const entry = byDate.get(resolved.todayDate);
    if (entry) {
      entry.total += todayCalls.length;
      entry.connected += todayCalls.filter((c) => c.answered_at != null).length;
      entry.transfers += todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'TRANSFERRED').length;
      const durs = todayCalls.map((c) => c.duration_seconds).filter((v): v is number => v != null);
      const avg = average(durs);
      if (avg !== null) entry.durations.push(avg);
    }
  }

  const calls_by_day: DailyMetricPoint[] = [...byDate.entries()].map(([date, v]) => ({
    date,
    total_calls: v.total,
    calls_connected: v.connected,
    average_duration_seconds: v.durations.length ? average(v.durations) : null,
    transfers: v.transfers,
    connection_rate: pct(v.connected, v.total),
  }));

  const connection_rate_trend: ChartPoint[] = calls_by_day.map((p) => ({ label: p.date, value: p.connection_rate }));
  const average_duration_trend: ChartPoint[] = calls_by_day.map((p) => ({ label: p.date, value: p.average_duration_seconds ?? 0 }));
  const transfer_statistics: ChartPoint[] = calls_by_day.map((p) => ({ label: p.date, value: p.transfers }));

  // --- calls_by_hour: bucketed by hour-of-day (0-23), summed across the period ---
  const hourOfDay = new Array(24).fill(0);
  for (const r of hourlyRows ?? []) {
    const h = new Date(r.hour_bucket).getUTCHours();
    hourOfDay[h] += r.total_calls;
  }
  if (resolved.includesToday) {
    for (const c of todayCalls) hourOfDay[new Date(c.created_at).getUTCHours()] += 1;
  }
  const calls_by_hour: ChartPoint[] = hourOfDay.map((value, h) => ({ label: `${String(h).padStart(2, '0')}:00`, value }));

  // --- disposition_breakdown: real GROUP BY over the period (never wider) ---
  const { data: dispositionRows } = await supabase.rpc('dashboard_disposition_breakdown', {
    match_organization_id: orgId,
    match_from: resolved.fromISO,
    match_to: resolved.toISO,
  });
  const disposition_breakdown: ChartPoint[] = ((dispositionRows as any[]) ?? []).map((r) => ({ label: r.name ?? r.code, value: Number(r.call_count) }));

  // --- campaign_performance / campaign_completion ---
  const { data: campaigns } = await supabase.from('campaigns').select('id, name').eq('organization_id', orgId);
  const campaignNameById = new Map((campaigns ?? []).map((c: any) => [c.id, c.name]));

  const campaignAgg = new Map<string, { total: number; connected: number }>();
  for (const r of campaignRows ?? []) {
    const e = campaignAgg.get(r.campaign_id) ?? { total: 0, connected: 0 };
    e.total += r.total_calls;
    e.connected += r.connected;
    campaignAgg.set(r.campaign_id, e);
  }
  if (resolved.includesToday) {
    for (const c of todayCalls) {
      if (!c.campaign_id) continue;
      const e = campaignAgg.get(c.campaign_id) ?? { total: 0, connected: 0 };
      e.total += 1;
      if (c.answered_at != null) e.connected += 1;
      campaignAgg.set(c.campaign_id, e);
    }
  }

  const { data: allCampaignLeads } = campaignAgg.size
    ? await supabase.from('campaign_leads').select('campaign_id, status').in('campaign_id', [...campaignAgg.keys()])
    : { data: [] as any[] };
  const completionByCampaign = new Map<string, { total: number; terminal: number }>();
  for (const cl of allCampaignLeads ?? []) {
    const e = completionByCampaign.get(cl.campaign_id) ?? { total: 0, terminal: 0 };
    e.total += 1;
    if (['completed', 'failed', 'dnc', 'skipped'].includes(cl.status)) e.terminal += 1;
    completionByCampaign.set(cl.campaign_id, e);
  }

  const campaign_performance: CampaignPerformancePoint[] = [...campaignAgg.entries()].map(([campaignId, v]) => {
    const completion = completionByCampaign.get(campaignId);
    return {
      campaign_id: campaignId,
      campaign_name: campaignNameById.get(campaignId) ?? 'Unknown campaign',
      total_calls: v.total,
      connected: v.connected,
      connection_rate: pct(v.connected, v.total),
      completion_rate: completion ? pct(completion.terminal, completion.total) : 0,
    };
  });

  const { data: allCampaignsForCompletion } = await supabase.from('campaigns').select('id, name').eq('organization_id', orgId).in('status', ['running', 'paused', 'scheduled', 'completed']);
  const completionCampaignIds = (allCampaignsForCompletion ?? []).map((c: any) => c.id);
  const { data: completionLeads } = completionCampaignIds.length
    ? await supabase.from('campaign_leads').select('campaign_id, status, attempt_count').in('campaign_id', completionCampaignIds)
    : { data: [] as any[] };
  const completionAgg = new Map<string, { total: number; called: number }>();
  for (const cl of completionLeads ?? []) {
    const e = completionAgg.get(cl.campaign_id) ?? { total: 0, called: 0 };
    e.total += 1;
    if (cl.attempt_count > 0) e.called += 1;
    completionAgg.set(cl.campaign_id, e);
  }
  const campaign_completion = (allCampaignsForCompletion ?? []).map((c: any) => {
    const e = completionAgg.get(c.id) ?? { total: 0, called: 0 };
    return { campaign_id: c.id, campaign_name: c.name, total_leads: e.total, leads_called: e.called, completion_pct: pct(e.called, e.total) };
  });

  // --- agent_performance ---
  const { data: agents } = await supabase.from('ai_agents').select('id, name').eq('organization_id', orgId);
  const agentNameById = new Map((agents ?? []).map((a: any) => [a.id, a.name]));

  const agentAgg = new Map<string, { total: number; connected: number; durations: number[]; evalScores: number[] }>();
  for (const r of agentRows ?? []) {
    const e = agentAgg.get(r.ai_agent_id) ?? { total: 0, connected: 0, durations: [], evalScores: [] };
    e.total += r.total_calls;
    e.connected += r.connected;
    if (r.avg_duration_seconds != null) e.durations.push(Number(r.avg_duration_seconds));
    if (r.avg_evaluation_score != null) e.evalScores.push(Number(r.avg_evaluation_score));
    agentAgg.set(r.ai_agent_id, e);
  }
  if (resolved.includesToday) {
    for (const c of todayCalls) {
      if (!c.ai_agent_id) continue;
      const e = agentAgg.get(c.ai_agent_id) ?? { total: 0, connected: 0, durations: [], evalScores: [] };
      e.total += 1;
      if (c.answered_at != null) e.connected += 1;
      agentAgg.set(c.ai_agent_id, e);
    }
  }

  const agent_performance: AgentPerformancePoint[] = [...agentAgg.entries()].map(([agentId, v]) => ({
    ai_agent_id: agentId,
    ai_agent_name: agentNameById.get(agentId) ?? 'Unknown agent',
    total_calls: v.total,
    connected: v.connected,
    connection_rate: pct(v.connected, v.total),
    average_duration_seconds: average(v.durations),
    average_evaluation_score: average(v.evalScores),
  }));

  return {
    period: resolved.period,
    date_from: resolved.fromDate,
    date_to: resolved.toDate,
    calls_by_hour,
    calls_by_day,
    connection_rate_trend,
    disposition_breakdown,
    campaign_performance,
    agent_performance,
    campaign_completion,
    average_duration_trend,
    transfer_statistics,
  };
}

// ---------------------------------------------------------------------
// GET /analytics/campaigns/:id
// ---------------------------------------------------------------------

export async function getCampaignAnalytics(supabase: Supabase, orgId: string, campaign: { id: string; name: string }, resolved: ResolvedPeriod): Promise<CampaignAnalytics> {
  const histDates = historicalDates(resolved);
  const { data: rollupRows } = histDates.length
    ? await supabase.from('analytics_daily_campaign').select('*').eq('organization_id', orgId).eq('campaign_id', campaign.id).in('date', histDates)
    : { data: [] as any[] };
  const rows: any[] = rollupRows ?? [];

  const todayCalls = (await fetchTodayCalls(supabase, orgId, resolved)).filter((c) => c.campaign_id === campaign.id);
  const dispositionByCallId = await fetchDispositionCodesForCalls(supabase, orgId, todayCalls.map((c) => c.id));
  const { count: todayCallbacks } = resolved.includesToday
    ? await supabase
        .from('callbacks')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('campaign_id', campaign.id)
        .gte('created_at', startOfUtcDate(resolved.todayDate).toISOString())
        .lte('created_at', resolved.toISO)
    : { count: 0 };

  const todayVoicemail = todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'VOICEMAIL').length;
  const todayDnc = todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'DNC').length;
  const todayTransfers = todayCalls.filter((c) => dispositionByCallId.get(c.id) === 'TRANSFERRED').length;
  const todayConnected = todayCalls.filter((c) => c.answered_at != null).length;
  const todayDurations = todayCalls.map((c) => c.duration_seconds).filter((v): v is number => v != null);

  const calls = rows.reduce((a, r) => a + r.total_calls, 0) + todayCalls.length;
  const connected = rows.reduce((a, r) => a + r.connected, 0) + todayConnected;
  const voicemail = rows.reduce((a, r) => a + r.voicemail, 0) + todayVoicemail;
  const dnc = rows.reduce((a, r) => a + r.dnc, 0) + todayDnc;
  const transfers = rows.reduce((a, r) => a + r.transfers, 0) + todayTransfers;
  const callbacks = rows.reduce((a, r) => a + r.callbacks, 0) + (todayCallbacks ?? 0);
  const avgDuration = weightedAverage([
    ...rows.map((r) => ({ avg: r.avg_duration_seconds != null ? Number(r.avg_duration_seconds) : null, weight: r.total_calls })),
    { avg: average(todayDurations), weight: todayCalls.length },
  ]);

  const { data: campaignLeads } = await supabase.from('campaign_leads').select('status, attempt_count').eq('campaign_id', campaign.id);
  const leads = campaignLeads ?? [];
  const totalLeads = leads.length;
  const terminalLeads = leads.filter((l: any) => ['completed', 'failed', 'dnc', 'skipped'].includes(l.status)).length;
  const totalAttempts = leads.reduce((a: number, l: any) => a + (l.attempt_count ?? 0), 0);

  return {
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    period: resolved.period,
    date_from: resolved.fromDate,
    date_to: resolved.toDate,
    total_leads: totalLeads,
    calls,
    connected,
    voicemail,
    dnc,
    transfers,
    callbacks,
    average_duration_seconds: avgDuration,
    completion_pct: pct(terminalLeads, totalLeads),
    attempts_per_lead: totalLeads > 0 ? Math.round((totalAttempts / totalLeads) * 100) / 100 : 0,
  };
}

// ---------------------------------------------------------------------
// GET /analytics/agents
// ---------------------------------------------------------------------

export async function getAgentAnalytics(supabase: Supabase, orgId: string, resolved: ResolvedPeriod): Promise<AgentAnalytics[]> {
  const { data: agents } = await supabase.from('ai_agents').select('id, name').eq('organization_id', orgId);
  const agentList: Array<{ id: string; name: string }> = agents ?? [];
  if (agentList.length === 0) return [];

  const histDates = historicalDates(resolved);
  const { data: rollupRows } = histDates.length
    ? await supabase.from('analytics_daily_agent').select('*').eq('organization_id', orgId).in('date', histDates)
    : { data: [] as any[] };
  const rowsByAgent = new Map<string, any[]>();
  for (const r of rollupRows ?? []) {
    const list = rowsByAgent.get(r.ai_agent_id) ?? [];
    list.push(r);
    rowsByAgent.set(r.ai_agent_id, list);
  }

  const todayCalls = await fetchTodayCalls(supabase, orgId, resolved);
  const dispositionByCallId = await fetchDispositionCodesForCalls(supabase, orgId, todayCalls.map((c) => c.id));

  // Callbacks and disposition-override accuracy aren't in the daily_agent
  // rollup (see the migration's column list) - computed live for the
  // whole period via a couple of targeted, indexed joins.
  const { data: allDispositionsInRange } = await supabase
    .from('call_dispositions')
    .select('call_id, disposition_source')
    .eq('organization_id', orgId)
    .gte('assigned_at', resolved.fromISO)
    .lte('assigned_at', resolved.toISO);
  const callIdsWithDisposition = (allDispositionsInRange ?? []).map((d: any) => d.call_id);
  let callAgentAndTiming: Array<{ id: string; ai_agent_id: string | null }> = [];
  if (callIdsWithDisposition.length > 0) {
    const { data } = await supabase.from('calls').select('id, ai_agent_id').in('id', callIdsWithDisposition).eq('organization_id', orgId);
    callAgentAndTiming = data ?? [];
  }
  const agentIdByCallId = new Map(callAgentAndTiming.map((c) => [c.id, c.ai_agent_id]));
  const dispositionCountsByAgent = new Map<string, { total: number; manual: number }>();
  for (const d of allDispositionsInRange ?? []) {
    const agentId = agentIdByCallId.get(d.call_id);
    if (!agentId) continue;
    const e = dispositionCountsByAgent.get(agentId) ?? { total: 0, manual: 0 };
    e.total += 1;
    if (d.disposition_source === 'manual') e.manual += 1;
    dispositionCountsByAgent.set(agentId, e);
  }

  const { data: callbacksInRange } = await supabase
    .from('callbacks')
    .select('id, source_call_id')
    .eq('organization_id', orgId)
    .gte('created_at', resolved.fromISO)
    .lte('created_at', resolved.toISO);
  const sourceCallIds = (callbacksInRange ?? []).map((cb: any) => cb.source_call_id).filter(Boolean);
  let sourceCalls: Array<{ id: string; ai_agent_id: string | null }> = [];
  if (sourceCallIds.length > 0) {
    const { data } = await supabase.from('calls').select('id, ai_agent_id').in('id', sourceCallIds);
    sourceCalls = data ?? [];
  }
  const agentIdBySourceCallId = new Map(sourceCalls.map((c) => [c.id, c.ai_agent_id]));
  const callbacksByAgent = new Map<string, number>();
  for (const cb of callbacksInRange ?? []) {
    const agentId = cb.source_call_id ? agentIdBySourceCallId.get(cb.source_call_id) : null;
    if (!agentId) continue;
    callbacksByAgent.set(agentId, (callbacksByAgent.get(agentId) ?? 0) + 1);
  }

  const results: AgentAnalytics[] = [];
  for (const agent of agentList) {
    const rows = rowsByAgent.get(agent.id) ?? [];
    const todayAgentCalls = todayCalls.filter((c) => c.ai_agent_id === agent.id);

    const calls = rows.reduce((a, r) => a + r.total_calls, 0) + todayAgentCalls.length;
    const connected = rows.reduce((a, r) => a + r.connected, 0) + todayAgentCalls.filter((c) => c.answered_at != null).length;
    const transfers = rows.reduce((a, r) => a + r.transfers, 0) + todayAgentCalls.filter((c) => dispositionByCallId.get(c.id) === 'TRANSFERRED').length;
    const dnc = rows.reduce((a, r) => a + r.dnc, 0) + todayAgentCalls.filter((c) => dispositionByCallId.get(c.id) === 'DNC').length;
    const voicemail = rows.reduce((a, r) => a + r.voicemail, 0) + todayAgentCalls.filter((c) => dispositionByCallId.get(c.id) === 'VOICEMAIL').length;
    // analytics_daily_agent (spec's exact column list) carries connected/
    // transfers/dnc/voicemail but NOT a per-day "completed" count, so
    // successful/failed outcomes for the historical portion of the
    // period can only be derived from those columns - documented choice:
    // a "successful outcome" is any call that actually connected
    // (answered_at set); "conversion" is narrowed further to a real
    // transfer to a human, the clearest positive signal the rollup
    // carries; anything that never connected is a failed outcome.
    const successfulOutcomes = connected;
    const failedOutcomes = Math.max(calls - connected, 0);
    const conversions = transfers;
    const avgDuration = weightedAverage([
      ...rows.map((r) => ({ avg: r.avg_duration_seconds != null ? Number(r.avg_duration_seconds) : null, weight: r.total_calls })),
      { avg: average(todayAgentCalls.map((c) => c.duration_seconds).filter((v): v is number => v != null)), weight: todayAgentCalls.length },
    ]);

    const dispositionCounts = dispositionCountsByAgent.get(agent.id);
    const dispositionAccuracy = dispositionCounts && dispositionCounts.total > 0 ? Math.round((1 - dispositionCounts.manual / dispositionCounts.total) * 10000) / 100 : null;

    const { data: evalSummary } = await supabase.rpc('agent_evaluation_summary', {
      match_organization_id: orgId,
      match_agent_id: agent.id,
      match_since: resolved.fromISO,
    });
    const evalRow = (evalSummary as any[])?.[0];

    results.push({
      ai_agent_id: agent.id,
      ai_agent_name: agent.name,
      period: resolved.period,
      date_from: resolved.fromDate,
      date_to: resolved.toDate,
      calls,
      connected_calls: connected,
      connection_rate: pct(connected, calls),
      average_duration_seconds: avgDuration,
      transfers,
      dnc,
      voicemail,
      conversions,
      callbacks: callbacksByAgent.get(agent.id) ?? 0,
      successful_outcomes: successfulOutcomes,
      failed_outcomes: failedOutcomes,
      disposition_accuracy: dispositionAccuracy,
      average_evaluation_score: evalRow?.average_overall_score ?? null,
      evaluation_call_count: evalRow?.call_count ?? 0,
    });
  }

  return results;
}
