import { useMemo, useState } from 'react';
import type { AgentAnalytics } from '@shivanshconnect/shared';
import clsx from 'clsx';
import { useCampaigns } from '../hooks/useCampaigns';
import { useAgentAnalytics, useCampaignAnalytics, type PeriodFilterValue } from '../hooks/useAnalytics';
import { PeriodFilter } from '../components/analytics/PeriodFilter';
import { ProgressBar } from '../components/analytics/charts';
import { Card } from '../components/ui';

type Tab = 'campaigns' | 'agents';

function formatSeconds(seconds: number | null): string {
  if (seconds == null) return '–';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function pct(value: number | null): string {
  return value == null ? '–' : `${value.toFixed(1)}%`;
}

function CampaignAnalyticsTab({ period }: { period: PeriodFilterValue }): JSX.Element {
  const campaignsQuery = useCampaigns(1, 100);
  const [campaignId, setCampaignId] = useState<string>('');
  const campaigns = campaignsQuery.data?.data ?? [];
  const effectiveId = campaignId || campaigns[0]?.id;
  const analyticsQuery = useCampaignAnalytics(effectiveId, period);

  return (
    <div className="mt-4 space-y-4">
      <div className="max-w-sm">
        <label className="mb-1 block text-xs font-medium text-ink-600">Campaign</label>
        <select
          value={effectiveId ?? ''}
          onChange={(e) => setCampaignId(e.target.value)}
          className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-900"
        >
          {campaigns.length === 0 && <option value="">No campaigns yet</option>}
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {!effectiveId && <Card className="text-sm text-ink-400">Create a campaign to see its analytics here.</Card>}

      {effectiveId && analyticsQuery.data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ['Total Leads', analyticsQuery.data.total_leads.toLocaleString()],
              ['Calls', analyticsQuery.data.calls.toLocaleString()],
              ['Connected', analyticsQuery.data.connected.toLocaleString()],
              ['Voicemail', analyticsQuery.data.voicemail.toLocaleString()],
              ['DNC', analyticsQuery.data.dnc.toLocaleString()],
              ['Transfers', analyticsQuery.data.transfers.toLocaleString()],
              ['Callbacks', analyticsQuery.data.callbacks.toLocaleString()],
              ['Average Duration', formatSeconds(analyticsQuery.data.average_duration_seconds)],
              ['Attempts / Lead', analyticsQuery.data.attempts_per_lead.toFixed(2)],
            ].map(([label, value]) => (
              <Card key={label} className="p-4">
                <p className="text-xs font-medium text-ink-500">{label}</p>
                <p className="mt-1 text-xl font-semibold text-ink-900">{value}</p>
              </Card>
            ))}
          </div>
          <Card>
            <ProgressBar label="Completion" value={analyticsQuery.data.completion_pct} />
          </Card>
        </>
      )}
    </div>
  );
}

type SortKey = keyof Pick<AgentAnalytics, 'calls' | 'connection_rate' | 'average_duration_seconds' | 'transfers' | 'dnc' | 'voicemail' | 'conversions' | 'callbacks' | 'disposition_accuracy' | 'average_evaluation_score'>;

function AgentAnalyticsTab({ period }: { period: PeriodFilterValue }): JSX.Element {
  const agentsQuery = useAgentAnalytics(period);
  const [sortKey, setSortKey] = useState<SortKey>('calls');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [minCalls, setMinCalls] = useState(0);

  const rows = useMemo(() => {
    const data = (agentsQuery.data ?? []).filter((a) => a.calls >= minCalls);
    return [...data].sort((a, b) => {
      const av = a[sortKey] ?? -1;
      const bv = b[sortKey] ?? -1;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [agentsQuery.data, sortKey, sortDir, minCalls]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const columns: Array<{ key: SortKey; label: string; format: (a: AgentAnalytics) => string }> = [
    { key: 'calls', label: 'Calls', format: (a) => a.calls.toLocaleString() },
    { key: 'connection_rate', label: 'Connection Rate', format: (a) => pct(a.connection_rate) },
    { key: 'average_duration_seconds', label: 'Avg Duration', format: (a) => formatSeconds(a.average_duration_seconds) },
    { key: 'transfers', label: 'Transfers', format: (a) => a.transfers.toLocaleString() },
    { key: 'dnc', label: 'DNC', format: (a) => a.dnc.toLocaleString() },
    { key: 'voicemail', label: 'Voicemail', format: (a) => a.voicemail.toLocaleString() },
    { key: 'conversions', label: 'Conversion', format: (a) => a.conversions.toLocaleString() },
    { key: 'callbacks', label: 'Callbacks', format: (a) => a.callbacks.toLocaleString() },
    { key: 'disposition_accuracy', label: 'Disposition Accuracy', format: (a) => pct(a.disposition_accuracy) },
    { key: 'average_evaluation_score', label: 'Evaluation Score', format: (a) => (a.average_evaluation_score == null ? '–' : `${a.average_evaluation_score.toFixed(1)} / 100`) },
  ];

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2 text-xs text-ink-600">
        <label htmlFor="min-calls">Minimum calls</label>
        <input
          id="min-calls"
          type="number"
          min={0}
          value={minCalls}
          onChange={(e) => setMinCalls(Number(e.target.value) || 0)}
          className="w-20 rounded-md border border-ink-300 px-2 py-1"
        />
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs text-ink-500">
              <th className="px-4 py-2">Agent</th>
              {columns.map((col) => (
                <th key={col.key} className="cursor-pointer select-none px-4 py-2 hover:text-ink-800" onClick={() => toggleSort(col.key)}>
                  {col.label} {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.ai_agent_id} className="border-b border-ink-100 last:border-0">
                <td className="px-4 py-2 font-medium text-ink-900">{a.ai_agent_name}</td>
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-2 text-ink-700">
                    {col.format(a)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-6 text-center text-ink-400">
                  No agents with calls in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function AnalyticsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [period, setPeriod] = useState<PeriodFilterValue>({ period: '30d' });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Analytics</h1>
          <p className="mt-1 text-sm text-ink-500">Deep-dive campaign and AI agent performance, per spec section 42.</p>
        </div>
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>

      <div className="mt-4 inline-flex rounded-md border border-ink-200 bg-white p-1">
        {(['campaigns', 'agents'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={clsx('rounded px-4 py-1.5 text-sm font-medium capitalize transition-colors', tab === t ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100')}
          >
            {t === 'campaigns' ? 'Campaign Analytics' : 'Agent Analytics'}
          </button>
        ))}
      </div>

      {tab === 'campaigns' ? <CampaignAnalyticsTab period={period} /> : <AgentAnalyticsTab period={period} />}
    </div>
  );
}
