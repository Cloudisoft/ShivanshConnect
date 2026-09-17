import type { LiveMonitorActiveCall } from '@shivanshconnect/shared';
import { Badge } from '../ui';
import { useNow } from '../../hooks/useNow';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  dialing: 'neutral',
  ringing: 'warning',
  answered: 'success',
  in_progress: 'success',
  voicemail: 'neutral',
  answering_machine: 'neutral',
  transfer_pending: 'warning',
  transferring: 'warning',
};

function formatDuration(startedAt: string | null, nowMs: number): string {
  if (!startedAt) return '00:00';
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Phase 10: the Live Monitor active-calls table - driven entirely by the
 * WebSocket-backed state useLiveMonitorSocket() maintains (no manual
 * refresh, no polling). Duration ticks live via useNow().
 */
export function LiveCallsTable({
  calls,
  onSelect,
  selectedCallId,
}: {
  calls: LiveMonitorActiveCall[];
  onSelect: (callId: string) => void;
  selectedCallId: string | null;
}): JSX.Element {
  const now = useNow(1000);

  if (calls.length === 0) {
    return <p className="py-10 text-center text-sm text-ink-500">No active calls right now.</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
          <th className="py-2 pr-3">Call</th>
          <th className="py-2 pr-3">Campaign</th>
          <th className="py-2 pr-3">Lead</th>
          <th className="py-2 pr-3">Phone</th>
          <th className="py-2 pr-3">AI Agent</th>
          <th className="py-2 pr-3">Voice</th>
          <th className="py-2 pr-3">Duration</th>
          <th className="py-2 pr-3">State</th>
          <th className="py-2 pr-3">Started</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <tr
            key={call.id}
            onClick={() => onSelect(call.id)}
            className={`cursor-pointer border-b border-ink-100 hover:bg-ink-50 ${selectedCallId === call.id ? 'bg-ink-50' : ''}`}
          >
            <td className="py-2 pr-3 font-mono text-xs text-ink-500">{call.id.slice(0, 8)}</td>
            <td className="py-2 pr-3">{call.campaign_name ?? '-'}</td>
            <td className="py-2 pr-3">{call.lead_name ?? '-'}</td>
            <td className="py-2 pr-3 font-mono">{call.customer_number}</td>
            <td className="py-2 pr-3">{call.ai_agent_name ?? '-'}</td>
            <td className="py-2 pr-3">{call.voice_name ?? '-'}</td>
            <td className="py-2 pr-3 font-mono">{formatDuration(call.started_at ?? call.answered_at, now)}</td>
            <td className="py-2 pr-3">
              <Badge tone={STATUS_TONE[call.status] ?? 'neutral'}>{call.status.replace(/_/g, ' ')}</Badge>
            </td>
            <td className="py-2 pr-3 text-ink-500">{call.started_at ? new Date(call.started_at).toLocaleTimeString() : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
