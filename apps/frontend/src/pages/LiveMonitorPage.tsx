import { useState } from 'react';
import { Radio, WifiOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useLiveMonitorSocket } from '../hooks/useLiveMonitor';
import { LiveCallsTable } from '../components/liveMonitor/LiveCallsTable';
import { CallDetailPanel } from '../components/liveMonitor/CallDetailPanel';
import { Card } from '../components/ui';

/**
 * Phase 10: Live Monitor - replaces the sidebar placeholder with a real,
 * WebSocket-driven module (master spec section 18). Every row in the
 * active-calls table and every transcript segment in the detail panel
 * comes from ws/liveMonitor.ts's real-time stream - there is no manual
 * refresh button and no polling anywhere in this page.
 */
export function LiveMonitorPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const { status, calls, transcripts } = useLiveMonitorSocket();
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  const canListen = hasPermission('live_monitor.listen');
  const canBarge = hasPermission('live_monitor.barge');
  const canWhisper = hasPermission('live_monitor.whisper');

  const callList = [...calls.values()].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  const selectedCall = selectedCallId ? calls.get(selectedCallId) : null;
  const selectedSegments = selectedCallId ? (transcripts.get(selectedCallId) ?? []) : [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Live Monitor</h1>
          <p className="mt-1 text-sm text-ink-500">
            Real-time active calls, transcript, and listen/whisper/barge/transfer controls.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {status === 'open' ? (
            <span className="flex items-center gap-1.5 text-green-700">
              <Radio className="h-4 w-4 animate-pulse" /> Live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ink-500">
              <WifiOff className="h-4 w-4" /> {status === 'connecting' ? 'Connecting...' : status === 'reconnecting' ? 'Reconnecting...' : 'Disconnected'}
            </span>
          )}
        </div>
      </div>

      <Card className="mt-4 overflow-x-auto">
        <LiveCallsTable calls={callList} onSelect={setSelectedCallId} selectedCallId={selectedCallId} />
      </Card>

      {selectedCall && (
        <CallDetailPanel
          call={selectedCall}
          segments={selectedSegments}
          onClose={() => setSelectedCallId(null)}
          canListen={canListen}
          canBarge={canBarge}
          canWhisper={canWhisper}
        />
      )}
    </div>
  );
}
