import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  LiveMonitorActiveCall,
  LiveMonitorHeartbeat,
  LiveMonitorSnapshot,
  LiveMonitorTranscriptSegment,
  LiveMonitorWsEvent,
} from '@shivanshconnect/shared';
import { api, API_BASE_URL } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

/** Derives the Live Monitor WS URL from the same API base the REST client
 * uses (http(s) -> ws(s), same host/path) - never a second, separately
 * configured endpoint to keep in sync. */
function wsBaseUrl(): string {
  return API_BASE_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

/** The server sends a HEARTBEAT every 20s (see ws/liveMonitorRoutes.ts) for
 * as long as the connection is genuinely open. Some proxies silently drop
 * an idle WebSocket without ever delivering a close frame to either side -
 * that leaves `ws.readyState` reporting OPEN forever with nothing ever
 * arriving again, which is exactly the "Live Monitor stopped updating,
 * calls never move to connected/ended" symptom: the UI has no signal
 * anything is wrong, so it never reconnects. Missing more than two
 * heartbeats' worth of silence means the connection is dead even though
 * neither side has been told yet - force-close it so the existing
 * onclose-driven reconnect logic below takes over. */
const HEARTBEAT_TIMEOUT_MS = 45000;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface LiveMonitorState {
  status: ConnectionStatus;
  calls: Map<string, LiveMonitorActiveCall>;
  transcripts: Map<string, LiveMonitorTranscriptSegment[]>;
  lastEventByCall: Map<string, LiveMonitorWsEvent>;
}

/** Call-lifecycle event types (excludes SNAPSHOT/HEARTBEAT and
 * TRANSCRIPT_UPDATED, which fires many times per call and never changes a
 * CDR row or a campaign's counts) that mean "a CDR row or a campaign's
 * live counts just changed on the server" - worth pushing an instant
 * refetch for rather than waiting on CDR's/Campaigns' own 5s polls. */
const CDR_CAMPAIGN_RELEVANT_EVENTS = new Set([
  'CALL_STARTED',
  'CALL_CONNECTED',
  'CALL_TRANSFER_CONNECTED',
  'CALL_TRANSFER_FAILED',
  'CALL_ENDED',
]);

/**
 * Phase 10: the real-time WebSocket connection backing Live Monitor and
 * (via the same events) instant CDR/Campaigns cache invalidation - no
 * polling alone anywhere that this connection is open. Connects to
 * WS /api/v1/live-monitor/stream, applies the initial SNAPSHOT, then folds
 * every subsequent event into the same in-memory active-calls/transcripts
 * state as it arrives. Reconnects with backoff on an unexpected close
 * (e.g. a token nearing expiry, a network blip) - never silently gives up.
 *
 * Exactly ONE of these connections exists for the whole authenticated app -
 * see LiveMonitorSocketProvider/AppShell.tsx - rather than every page that
 * wants live call data (Live Monitor, Dashboard) each opening its own, so
 * CDR and Campaigns get the same instant push no matter which page is
 * actually open, not only while Live Monitor itself happens to be mounted.
 */
function useLiveMonitorConnection(): LiveMonitorState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveMonitorState>({
    status: 'connecting',
    calls: new Map(),
    transcripts: new Map(),
    lastEventByCall: new Map(),
  });
  const wsRef = useRef<WebSocket | null>(null);
  const retryDelayRef = useRef(1000);
  const closedByUsRef = useRef(false);
  const lastMessageAtRef = useRef(Date.now());

  useEffect(() => {
    closedByUsRef.current = false;

    async function connect() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token || closedByUsRef.current) return;

      setState((s) => ({ ...s, status: s.status === 'connecting' ? 'connecting' : 'reconnecting' }));
      const ws = new WebSocket(`${wsBaseUrl()}/live-monitor/stream?token=${encodeURIComponent(session.access_token)}`);
      wsRef.current = ws;
      lastMessageAtRef.current = Date.now();

      const watchdog = setInterval(() => {
        if (Date.now() - lastMessageAtRef.current > HEARTBEAT_TIMEOUT_MS) {
          ws.close(); // dead connection the server/proxy never told us about - onclose below reconnects
        }
      }, 10000);

      ws.onopen = () => {
        retryDelayRef.current = 1000;
        lastMessageAtRef.current = Date.now();
        setState((s) => ({ ...s, status: 'open' }));
      };

      ws.onmessage = (event) => {
        lastMessageAtRef.current = Date.now();
        let payload: LiveMonitorSnapshot | LiveMonitorWsEvent | LiveMonitorHeartbeat;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload.type === 'HEARTBEAT') return;

        if (payload.type !== 'SNAPSHOT' && CDR_CAMPAIGN_RELEVANT_EVENTS.has(payload.type)) {
          // Push, not poll: instead of CDR/Campaigns finding out up to 5s
          // later on their own interval, refetch the moment the call
          // actually changed - "CDR/campaign stats should update in real
          // time" rather than looking frozen until the next poll tick.
          queryClient.invalidateQueries({ queryKey: ['cdr'] });
          queryClient.invalidateQueries({ queryKey: ['campaigns'] });
        }

        setState((prev) => {
          if (payload.type === 'SNAPSHOT') {
            const calls = new Map(payload.calls.map((c) => [c.id, c]));
            return { ...prev, calls };
          }

          const next: LiveMonitorState = {
            ...prev,
            calls: new Map(prev.calls),
            transcripts: new Map(prev.transcripts),
            lastEventByCall: new Map(prev.lastEventByCall),
          };
          next.lastEventByCall.set(payload.call_id, payload);

          if (payload.type === 'CALL_ENDED') {
            next.calls.delete(payload.call_id);
          } else if (payload.call) {
            next.calls.set(payload.call_id, payload.call);
          }

          if (payload.type === 'TRANSCRIPT_UPDATED' && payload.segment) {
            const existing = next.transcripts.get(payload.call_id) ?? [];
            if (!existing.some((s) => s.segment_index === payload.segment!.segment_index)) {
              next.transcripts.set(payload.call_id, [...existing, payload.segment].sort((a, b) => a.segment_index - b.segment_index));
            }
          }

          return next;
        });
      };

      ws.onclose = () => {
        clearInterval(watchdog);
        wsRef.current = null;
        if (closedByUsRef.current) {
          setState((s) => ({ ...s, status: 'closed' }));
          return;
        }
        setState((s) => ({ ...s, status: 'reconnecting' }));
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 15000);
        setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      closedByUsRef.current = true;
      wsRef.current?.close();
    };
  }, [queryClient]);

  return state;
}

const LiveMonitorContext = createContext<LiveMonitorState | null>(null);

/** Mounted once, in AppShell.tsx, around every authenticated route - owns
 * the single shared WS connection described above. */
export function LiveMonitorSocketProvider({ children }: { children: ReactNode }): JSX.Element {
  const state = useLiveMonitorConnection();
  return <LiveMonitorContext.Provider value={state}>{children}</LiveMonitorContext.Provider>;
}

/** Reads the shared connection - must be rendered under
 * LiveMonitorSocketProvider (true of every authenticated route via
 * AppShell.tsx). */
export function useLiveMonitorSocket(): LiveMonitorState {
  const ctx = useContext(LiveMonitorContext);
  if (!ctx) throw new Error('useLiveMonitorSocket must be used within LiveMonitorSocketProvider');
  return ctx;
}

// ---------------------------------------------------------------------
// Supervisor action mutations (listen/whisper/barge/transfer/end)
// ---------------------------------------------------------------------

export interface ListenResult {
  engine: 'vapi' | 'pipecat';
  ws_url: string;
  token?: string;
  supports_whisper_barge: boolean;
}

export function useListenCall() {
  return useMutation({
    mutationFn: (callId: string) => api.post<ListenResult>(`/calls/${callId}/listen`),
  });
}

export interface WhisperResult {
  engine: 'vapi' | 'pipecat';
  sent?: boolean;
  audible_to_caller?: boolean;
  ws_url?: string;
  token?: string;
  ended?: boolean;
}

export function useWhisperCall() {
  return useMutation({
    mutationFn: ({ callId, text, action }: { callId: string; text?: string; action?: 'start' | 'message' | 'end' }) =>
      api.post<WhisperResult>(`/calls/${callId}/whisper`, { text, action }),
  });
}

export interface BargeResult {
  engine: 'vapi' | 'pipecat';
  mode?: string;
  ws_url?: string;
  token?: string;
  ended?: boolean;
}

export function useBargeCall() {
  return useMutation({
    mutationFn: ({ callId, action }: { callId: string; action: 'start' | 'end' }) =>
      api.post<BargeResult>(`/calls/${callId}/barge`, { action }),
  });
}

export function useTransferCall() {
  return useMutation({
    mutationFn: ({ callId, destination_e164 }: { callId: string; destination_e164: string }) =>
      api.post(`/calls/${callId}/transfer`, { destination_e164 }),
  });
}

export function useEndCall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => api.post(`/calls/${callId}/end`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cdr'] }),
  });
}
