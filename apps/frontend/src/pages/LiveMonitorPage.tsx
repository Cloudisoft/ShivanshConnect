import { useEffect, useRef, useState } from 'react';
import { Radio, WifiOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useLiveMonitorSocket } from '../hooks/useLiveMonitor';
import { LiveCallsTable } from '../components/liveMonitor/LiveCallsTable';
import { CallDetailPanel } from '../components/liveMonitor/CallDetailPanel';
import { Card } from '../components/ui';
import { unlockAudio } from '../lib/pcmAudio';

const CONNECTED_STATUSES = ['answered', 'in_progress', 'voicemail', 'answering_machine', 'transfer_pending', 'transferring'];

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
 * Auto-listen starts audio the moment the open call connects (a person or
 * voicemail on the line); Follow live calls opens a live call by itself
 * when none is open. Any click on this page unlocks browser audio, so
 * listening can then start without a click.
 */
export function LiveMonitorPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const { status, calls, transcripts, partials } = useLiveMonitorSocket();
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [autoListen, setAutoListen] = useStoredToggle('sc:liveMonitor:autoListen', true);
  const [follow, setFollow] = useStoredToggle('sc:liveMonitor:follow', true);
  // Calls the viewer closed themselves - never re-opened by Follow.
  const dismissedRef = useRef<Set<string>>(new Set());
  // Closing the panel pauses Follow (otherwise, in a big batch, the next
  // call would pop open straight away and the table could never be seen).
  const [followPaused, setFollowPaused] = useState(false);

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

  // Follow: when no live call is open (none yet, or the open one ended),
  // open the newest connected call - or the newest ringing one.
  useEffect(() => {
    if (!follow || followPaused || selectedCall) return;
    const candidates = callList.filter((c) => !dismissedRef.current.has(c.id));
    const next = candidates.find((c) => CONNECTED_STATUSES.includes(c.status)) ?? candidates[0];
    if (next) setSelectedCallId(next.id);
  }, [follow, followPaused, selectedCall, callList.map((c) => `${c.id}:${c.status}`).join('|')]);

  function closePanel() {
    if (selectedCallId) dismissedRef.current.add(selectedCallId);
    setSelectedCallId(null);
    setFollowPaused(true);
  }

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
            <label className="flex items-center gap-2 text-ink-700" title="Start hearing a call as soon as it connects to a person or voicemail">
              <input type="checkbox" className="h-4 w-4 rounded border-ink-300" checked={autoListen} onChange={(e) => setAutoListen(e.target.checked)} />
              Auto-listen
            </label>
          )}
          <label className="flex items-center gap-2 text-ink-700" title="Open a live call automatically when none is open">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-ink-300"
              checked={follow && !followPaused}
              onChange={(e) => {
                setFollow(e.target.checked);
                setFollowPaused(false);
              }}
            />
            Follow live calls{follow && followPaused ? ' (paused)' : ''}
          </label>
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
          onClose={closePanel}
          canListen={canListen}
          canBarge={canBarge}
          canWhisper={canWhisper}
        />
      )}
    </div>
  );
}
