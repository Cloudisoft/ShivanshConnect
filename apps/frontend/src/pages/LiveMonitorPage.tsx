import { useEffect, useState } from 'react';
import { Headphones, Radio, WifiOff } from 'lucide-react';
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
 * The viewer picks which calls to listen to by ticking them - nothing
 * opens by itself otherwise. The first ticked call that connects (a person
 * or voicemail on the line) opens, and Auto-listen starts its audio; when
 * it ends, the next connected ticked call opens. Clicking a row opens that
 * call directly. Any click also unlocks browser audio.
 */
export function LiveMonitorPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const { status, calls, transcripts, partials } = useLiveMonitorSocket();
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [autoListen, setAutoListen] = useStoredToggle('sc:liveMonitor:autoListen', true);
  // Calls ticked for listening. The first ticked call that connects opens
  // with its audio; when it ends, the next ticked one that is connected.
  const [listenIds, setListenIds] = useState<Set<string>>(() => new Set());

  const canListen = hasPermission('live_monitor.listen');
  const canBarge = hasPermission('live_monitor.barge');
  const canWhisper = hasPermission('live_monitor.whisper');

  const callList = [...calls.values()].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  const selectedCall = selectedCallId ? calls.get(selectedCallId) : null;
  const selectedSegments = selectedCallId ? (transcripts.get(selectedCallId) ?? []) : [];

  // Ticked calls that have ended drop out of the selection.
  const liveKey = callList.map((c) => `${c.id}:${c.status}`).join('|');
  useEffect(() => {
    setListenIds((prev) => {
      const next = new Set([...prev].filter((id) => calls.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [liveKey]);

  useEffect(() => {
    if (selectedCall) return;
    const next = callList.find((c) => listenIds.has(c.id) && CONNECTED_STATUSES.includes(c.status));
    if (next) setSelectedCallId(next.id);
  }, [selectedCall, listenIds, liveKey]);

  function toggleListen(id: string) {
    unlockAudio();
    setListenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function closePanel() {
    // Closing a ticked call un-ticks it, so it doesn't reopen straight away.
    if (selectedCallId) {
      setListenIds((prev) => {
        if (!prev.has(selectedCallId)) return prev;
        const next = new Set(prev);
        next.delete(selectedCallId);
        return next;
      });
    }
    setSelectedCallId(null);
  }

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
            <label className="flex items-center gap-2 text-ink-700" title="Start hearing a ticked call as soon as it connects to a person or voicemail">
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
          {canListen
            ? listenIds.size > 0
              ? `${listenIds.size} call${listenIds.size === 1 ? '' : 's'} ticked - ${autoListen ? 'audio starts as soon as one connects' : 'it opens as soon as one connects'}.`
              : `Tick the calls you want to listen to in the list below${autoListen ? ' - audio starts as soon as one connects' : ''}, or click a call to open it.`
            : 'Click a call in the list below to monitor it.'}
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
          listenIds={canListen ? listenIds : undefined}
          onToggleListen={toggleListen}
          onToggleListenAll={(checked) => {
            unlockAudio();
            setListenIds(checked ? new Set(callList.map((c) => c.id)) : new Set());
          }}
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
