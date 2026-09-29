import { useEffect, useState } from 'react';
import { Headphones, Radio, WifiOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useLiveMonitorSocket } from '../hooks/useLiveMonitor';
import { LiveCallsTable } from '../components/liveMonitor/LiveCallsTable';
import { CallDetailPanel } from '../components/liveMonitor/CallDetailPanel';
import { Card } from '../components/ui';
import { unlockAudio } from '../lib/pcmAudio';

/** A per-viewer on/off preference, remembered in this browser. */
function useStoredToggle(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === '1';
    } catch {
      return fallback;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? '1' : '0');
    } catch {
      // Private mode etc. - the toggle still works for this visit.
    }
  };
  return [value, set];
}

/**
 * Phase 10: Live Monitor - replaces the sidebar placeholder with a real,
 * WebSocket-driven module (master spec section 18). Every row in the
 * active-calls table and every transcript segment in the detail panel
 * comes from ws/liveMonitor.ts's real-time stream - there is no manual
 * refresh button and no polling anywhere in this page.
 *
 * The viewer picks which call to monitor - nothing opens by itself.
 * Auto-listen then starts audio for the picked call the moment it connects
 * (a person or voicemail on the line). Picking a call is a click, which
 * also unlocks browser audio.
 */
export function LiveMonitorPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const { status, calls, transcripts, partials } = useLiveMonitorSocket();
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [autoListen, setAutoListen] = useStoredToggle('sc:liveMonitor:autoListen', true);

  const canListen = hasPermission('live_monitor.listen');
  const canBarge = hasPermission('live_monitor.barge');
  const canWhisper = hasPermission('live_monitor.whisper');

  const callList = [...calls.values()].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  const selectedCall = selectedCallId ? calls.get(selectedCallId) : null;
  const selectedSegments = selectedCallId ? (transcripts.get(selectedCallId) ?? []) : [];

  useEffect(() => {
    const onPointerDown = () => unlockAudio();
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Live Monitor</h1>
          <p className="mt-1 text-sm text-ink-500">
            Real-time active calls, transcript, and listen/whisper/barge/transfer controls.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {canListen && (
            <label className="flex items-center gap-2 text-ink-700" title="Start hearing the call you pick as soon as it connects to a person or voicemail">
              <input type="checkbox" className="h-4 w-4 rounded border-ink-300" checked={autoListen} onChange={(e) => setAutoListen(e.target.checked)} />
              Auto-listen
            </label>
          )}
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

      {!selectedCall && callList.length > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-gold-300 bg-gold-50 px-4 py-3 text-sm text-gold-800">
          <Headphones className="h-4 w-4 shrink-0" />
          Select the call you want to {canListen ? 'listen to' : 'monitor'} - click it in the list below.
          {canListen && autoListen ? ' Audio starts as soon as it connects.' : ''}
        </div>
      )}

      <Card className="mt-4 overflow-x-auto">
        <LiveCallsTable
          calls={callList}
          onSelect={(id) => {
            unlockAudio();
            setSelectedCallId(id);
          }}
          selectedCallId={selectedCallId}
        />
      </Card>

      {selectedCall && (
        <CallDetailPanel
          call={selectedCall}
          segments={selectedSegments}
          partials={partials.get(selectedCall.id)}
          autoListen={autoListen && canListen}
          onClose={() => setSelectedCallId(null)}
          canListen={canListen}
          canBarge={canBarge}
          canWhisper={canWhisper}
        />
      )}
    </div>
  );
}
