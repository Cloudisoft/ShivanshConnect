import type { DashboardMetrics } from '@shivanshconnect/shared';
import { Card } from '../ui';

function formatSecondsAsDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

interface Tile {
  label: string;
  value: string;
  tone?: 'default' | 'live';
}

/** The exact spec section 6 KPI tile grid, wired to real numbers - no
 * hardcoded figures. `live` tiles (Active Calls, Remaining Leads,
 * Campaigns Running, AI Agents Active) come from
 * DashboardMetrics fields that are ALWAYS live queries server-side,
 * regardless of the selected period - see services/analyticsQuery.ts. */
export function KpiGrid({ metrics, liveActiveCalls }: { metrics: DashboardMetrics; liveActiveCalls?: number }): JSX.Element {
  const tiles: Tile[] = [
    { label: 'Total Calls', value: metrics.total_calls.toLocaleString() },
    { label: 'Calls Connected', value: metrics.calls_connected.toLocaleString() },
    { label: 'Calls Completed', value: metrics.calls_completed.toLocaleString() },
    { label: 'Calls Failed', value: metrics.calls_failed.toLocaleString() },
    { label: 'Voicemails', value: metrics.voicemails.toLocaleString() },
    { label: 'Answering Machines', value: metrics.answering_machines.toLocaleString() },
    { label: 'DNC', value: metrics.dnc.toLocaleString() },
    { label: 'Not Interested', value: metrics.not_interested.toLocaleString() },
    { label: 'Transfers', value: metrics.transfers.toLocaleString() },
    { label: 'Callbacks', value: metrics.callbacks.toLocaleString() },
    { label: 'Average Call Duration', value: formatSecondsAsDuration(metrics.average_call_duration_seconds) },
    { label: 'Average Talk Time', value: formatSecondsAsDuration(metrics.average_talk_time_seconds) },
    { label: 'Connection Rate', value: `${metrics.connection_rate.toFixed(1)}%` },
    { label: 'Transfer Rate', value: `${metrics.transfer_rate.toFixed(1)}%` },
    { label: 'Voicemail Rate', value: `${metrics.voicemail_rate.toFixed(1)}%` },
    { label: 'DNC Rate', value: `${metrics.dnc_rate.toFixed(1)}%` },
    { label: 'Calls Per Hour', value: metrics.calls_per_hour.toFixed(1) },
    { label: 'Active Calls', value: (liveActiveCalls ?? metrics.active_calls).toLocaleString(), tone: 'live' },
    { label: 'Remaining Leads', value: metrics.remaining_leads.toLocaleString(), tone: 'live' },
    { label: 'Campaigns Running', value: metrics.campaigns_running.toLocaleString(), tone: 'live' },
    { label: 'AI Agents Active', value: metrics.ai_agents_active.toLocaleString(), tone: 'live' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {tiles.map((tile) => (
        <Card key={tile.label} className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-ink-500">{tile.label}</p>
            {tile.tone === 'live' && <span className="h-1.5 w-1.5 rounded-full bg-green-500" title="Live" />}
          </div>
          <p className="mt-1 text-xl font-semibold text-ink-900">{tile.value}</p>
        </Card>
      ))}
    </div>
  );
}
