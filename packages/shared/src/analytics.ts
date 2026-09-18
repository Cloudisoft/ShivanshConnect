/**
 * Phase 12: Analytics (dashboard, campaign analytics, agent analytics -
 * master spec sections 6, 42, 89). See
 * supabase/migrations/00000000000042_phase12_analytics_tables.sql for the
 * 4 pre-aggregated rollup tables these types mirror, and
 * apps/backend/src/services/analyticsAggregator.ts for how they're kept
 * up to date.
 */

export const ANALYTICS_PERIODS = ['today', 'yesterday', '7d', '30d', 'custom'] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

/** Exactly the spec section 6 metric list, in the spec's own naming. */
export interface DashboardMetrics {
  period: AnalyticsPeriod;
  date_from: string;
  date_to: string;

  total_calls: number;
  calls_connected: number;
  calls_completed: number;
  calls_failed: number;
  voicemails: number;
  answering_machines: number;
  dnc: number;
  not_interested: number;
  transfers: number;
  callbacks: number;
  average_call_duration_seconds: number;
  average_talk_time_seconds: number;

  connection_rate: number;
  transfer_rate: number;
  voicemail_rate: number;
  dnc_rate: number;
  calls_per_hour: number;

  /** Real, live counts - never from the rollup tables. */
  active_calls: number;
  remaining_leads: number;
  campaigns_running: number;
  ai_agents_active: number;
}

export interface ChartPoint {
  label: string;
  value: number;
}

export interface DailyMetricPoint {
  date: string;
  total_calls: number;
  calls_connected: number;
  average_duration_seconds: number | null;
  transfers: number;
  connection_rate: number;
}

export interface CampaignPerformancePoint {
  campaign_id: string;
  campaign_name: string;
  total_calls: number;
  connected: number;
  connection_rate: number;
  completion_rate: number;
}

export interface AgentPerformancePoint {
  ai_agent_id: string;
  ai_agent_name: string;
  total_calls: number;
  connected: number;
  connection_rate: number;
  average_duration_seconds: number | null;
  average_evaluation_score: number | null;
}

export interface DashboardCharts {
  period: AnalyticsPeriod;
  date_from: string;
  date_to: string;
  calls_by_hour: ChartPoint[];
  calls_by_day: DailyMetricPoint[];
  connection_rate_trend: ChartPoint[];
  disposition_breakdown: ChartPoint[];
  campaign_performance: CampaignPerformancePoint[];
  agent_performance: AgentPerformancePoint[];
  campaign_completion: Array<{ campaign_id: string; campaign_name: string; total_leads: number; leads_called: number; completion_pct: number }>;
  average_duration_trend: ChartPoint[];
  transfer_statistics: ChartPoint[];
}

export interface CampaignAnalytics {
  campaign_id: string;
  campaign_name: string;
  period: AnalyticsPeriod;
  date_from: string;
  date_to: string;

  total_leads: number;
  calls: number;
  connected: number;
  voicemail: number;
  dnc: number;
  transfers: number;
  callbacks: number;
  average_duration_seconds: number | null;
  completion_pct: number;
  attempts_per_lead: number;
}

/** One agent's row in the comparable KPI array (spec 42) - the frontend
 * builds its comparison table/chart directly off this array. */
export interface AgentAnalytics {
  ai_agent_id: string;
  ai_agent_name: string;
  period: AnalyticsPeriod;
  date_from: string;
  date_to: string;

  calls: number;
  connected_calls: number;
  connection_rate: number;
  average_duration_seconds: number | null;
  transfers: number;
  dnc: number;
  voicemail: number;
  conversions: number;
  callbacks: number;
  successful_outcomes: number;
  failed_outcomes: number;
  /** Practical proxy documented in routes/analytics.ts: the share of this
   * agent's dispositions that were NEVER manually overridden by a
   * supervisor (disposition_source stays 'engine'), i.e. 1 - override
   * rate. There is no independently-labeled "ground truth" disposition
   * to compare against, so a manual correction is treated as the
   * strongest available signal that the engine's own assignment was
   * wrong. */
  disposition_accuracy: number | null;
  average_evaluation_score: number | null;
  evaluation_call_count: number;
}
