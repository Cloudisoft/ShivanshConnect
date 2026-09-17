import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  LiveMonitorActiveCall,
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

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface LiveMonitorState {
  status: ConnectionStatus;
  calls: Map<string, LiveMonitorActiveCall>;
  transcripts: Map<string, LiveMonitorTranscriptSegment[]>;
  lastEventByCall: Map<string, LiveMonitorWsEvent>;
}

/**
 * Phase 10: the real-time WebSocket connection backing the entire Live
 * Monitor page - no polling anywhere in here. Connects to
 * WS /api/v1/live-monitor/stream, applies the initial SNAPSHOT, then
 * folds every subsequent event into the same in-memory active-calls/
 * transcripts state as it arrives. Reconnects with backoff on an
 * unexpected close (e.g. a token nearing expiry, a network blip) - never
 * silently gives up.
 */
export function useLiveMonitorSocket() {
  const [state, setState] = useState<LiveMonitorState>({
    status: 'connecting',
    calls: new Map(),
    transcripts: new Map(),
    lastEventByCall: new Map(),
  });
  const wsRef = useRef<WebSocket | null>(null);
  const retryDelayRef = useRef(1000);
  const closedByUsRef = useRef(false);

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

      ws.onopen = () => {
        retryDelayRef.current = 1000;
        setState((s) => ({ ...s, status: 'open' }));
      };

      ws.onmessage = (event) => {
        let payload: LiveMonitorSnapshot | LiveMonitorWsEvent;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
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
  }, []);

  return state;
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
