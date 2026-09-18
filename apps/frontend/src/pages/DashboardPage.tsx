import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useLiveMonitorSocket } from '../hooks/useLiveMonitor';
import { useDashboardCharts, useDashboardMetrics, type PeriodFilterValue } from '../hooks/useAnalytics';
import { PeriodFilter } from '../components/analytics/PeriodFilter';
import { KpiGrid } from '../components/analytics/KpiGrid';
import { CategoricalBarChart, ChartCard, ProgressBar, SimpleBarChart, SimpleLineChart } from '../components/analytics/charts';
import { Card } from '../components/ui';

export function DashboardPage(): JSX.Element {
  const { me } = useAuth();
  const [period, setPeriod] = useState<PeriodFilterValue>({ period: 'today' });

  const metricsQuery = useDashboardMetrics(period);
  const chartsQuery = useDashboardCharts(period);
  // Phase 10's real-time WS connection (Live Monitor) reused directly, per
  // the task brief - the Active Calls tile updates as soon as a call
  // starts/ends without waiting for the 30s metrics refetch.
  const liveMonitor = useLiveMonitorSocket();

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Dashboard</h1>
          <p className="mt-1 text-sm text-ink-500">
            {me?.organization.name} &middot; real-time and historical performance across every campaign and agent.
          </p>
        </div>
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>

      <div className="mt-6">
        {metricsQuery.isLoading && <Card className="text-sm text-ink-500">Loading metrics&hellip;</Card>}
        {metricsQuery.isError && <Card className="text-sm text-red-600">Could not load dashboard metrics.</Card>}
        {metricsQuery.data && <KpiGrid metrics={metricsQuery.data} liveActiveCalls={liveMonitor.status === 'open' ? liveMonitor.calls.size : undefined} />}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Calls by Hour" subtitle="Total calls, bucketed by hour of day" empty={!chartsQuery.data?.calls_by_hour.some((p) => p.value > 0)}>
          {chartsQuery.data && <SimpleBarChart data={chartsQuery.data.calls_by_hour} xKey="label" yKey="value" />}
        </ChartCard>
        <ChartCard title="Calls by Day" subtitle="Total call volume per day" empty={!chartsQuery.data?.calls_by_day.length}>
          {chartsQuery.data && <SimpleBarChart data={chartsQuery.data.calls_by_day} xKey="date" yKey="total_calls" />}
        </ChartCard>
        <ChartCard title="Connection Rate Trend" subtitle="% of calls connected, per day" empty={!chartsQuery.data?.connection_rate_trend.length}>
          {chartsQuery.data && <SimpleLineChart data={chartsQuery.data.connection_rate_trend} xKey="label" yKey="value" unit="%" />}
        </ChartCard>
        <ChartCard title="Average Duration Trend" subtitle="Average call duration (seconds), per day" empty={!chartsQuery.data?.average_duration_trend.length}>
          {chartsQuery.data && <SimpleLineChart data={chartsQuery.data.average_duration_trend} xKey="label" yKey="value" />}
        </ChartCard>
        <ChartCard title="Disposition Breakdown" subtitle="Calls by final disposition" empty={!chartsQuery.data?.disposition_breakdown.length}>
          {chartsQuery.data && <CategoricalBarChart data={chartsQuery.data.disposition_breakdown} xKey="label" yKey="value" />}
        </ChartCard>
        <ChartCard title="Transfer Statistics" subtitle="Transfers to a human, per day" empty={!chartsQuery.data?.transfer_statistics.some((p) => p.value > 0)}>
          {chartsQuery.data && <SimpleBarChart data={chartsQuery.data.transfer_statistics} xKey="label" yKey="value" color="#4a3aa7" />}
        </ChartCard>
        <ChartCard title="Campaign Performance" subtitle="Calls and connection rate per campaign" empty={!chartsQuery.data?.campaign_performance.length}>
          {chartsQuery.data && <CategoricalBarChart data={chartsQuery.data.campaign_performance.map((c) => ({ label: c.campaign_name, value: c.total_calls }))} xKey="label" yKey="value" />}
        </ChartCard>
        <ChartCard title="AI Agent Performance" subtitle="Calls per agent" empty={!chartsQuery.data?.agent_performance.length}>
          {chartsQuery.data && <CategoricalBarChart data={chartsQuery.data.agent_performance.map((a) => ({ label: a.ai_agent_name, value: a.total_calls }))} xKey="label" yKey="value" />}
        </ChartCard>
      </div>

      <Card className="mt-4">
        <h3 className="mb-3 text-sm font-semibold text-ink-900">Campaign Completion</h3>
        {chartsQuery.data?.campaign_completion.length ? (
          <div className="space-y-3">
            {chartsQuery.data.campaign_completion.map((c) => (
              <ProgressBar key={c.campaign_id} label={c.campaign_name} value={c.completion_pct} sublabel={`${c.leads_called} / ${c.total_leads} leads called`} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-400">No active or completed campaigns yet.</p>
        )}
      </Card>
    </div>
  );
}
