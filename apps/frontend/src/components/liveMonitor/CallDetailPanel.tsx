import { useEffect, useRef, useState } from 'react';
import { Headphones, Mic, Users, PhoneForwarded, PhoneOff, X, Loader2 } from 'lucide-react';
import type { LiveMonitorActiveCall, LiveMonitorTranscriptSegment } from '@shivanshconnect/shared';
import { Badge, Button, Alert } from '../ui';
import { ApiClientError } from '../../lib/apiClient';
import { PcmStreamPlayer, startMicPcmCapture } from '../../lib/pcmAudio';
import {
  useBargeCall,
  useEndCall,
  useListenCall,
  useTransferCall,
  useWhisperCall,
  type BargeResult,
  type ListenResult,
} from '../../hooks/useLiveMonitor';

type Mode = 'idle' | 'listening' | 'whispering' | 'barged_in';

const STATE_LABEL: Record<Mode, string> = {
  idle: 'Connected',
  listening: 'Listening',
  whispering: 'Whispering',
  barged_in: 'Barged In',
};
const STATE_TONE: Record<Mode, 'neutral' | 'success' | 'warning' | 'danger'> = {
  idle: 'neutral',
  listening: 'success',
  whispering: 'warning',
  barged_in: 'danger',
};

function speakerLabel(speaker: 'ai' | 'caller', voiceName: string | null | undefined): string {
  return speaker === 'ai' ? (voiceName ?? 'AI') : 'Caller';
}

/** Opens a raw binary WS to `wsUrl?token=token` and wires a PcmStreamPlayer
 * to every incoming frame. For pipecat, each frame's first byte is a
 * direction tag (0=caller,1=ai) - see apps/pipecat-service/app/
 * supervisor_hub.py's broadcast_audio(); Vapi's own listenUrl carries raw
 * PCM with no tag, so `stripDirectionByte` is false for it. */
function openListenSocket(wsUrl: string, token: string | undefined, stripDirectionByte: boolean): { socket: WebSocket; player: PcmStreamPlayer } {
  const url = token ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : wsUrl;
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const player = new PcmStreamPlayer();
  socket.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const bytes = stripDirectionByte ? event.data.slice(1) : event.data;
    player.push(new Int16Array(bytes));
  };
  return { socket, player };
}

export function CallDetailPanel({
  call,
  segments,
  onClose,
  canListen,
  canBarge,
  canWhisper,
}: {
  call: LiveMonitorActiveCall;
  segments: LiveMonitorTranscriptSegment[];
  onClose: () => void;
  canListen: boolean;
  canBarge: boolean;
  canWhisper: boolean;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [whisperText, setWhisperText] = useState('');
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);
  const [micStop, setMicStop] = useState<(() => void) | null>(null);

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const listenSocketRef = useRef<{ socket: WebSocket; player: PcmStreamPlayer } | null>(null);
  const injectSocketRef = useRef<WebSocket | null>(null);

  const listenMutation = useListenCall();
  const whisperMutation = useWhisperCall();
  const bargeMutation = useBargeCall();
  const transferMutation = useTransferCall();
  const endMutation = useEndCall();

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments.length]);

  // Tear down everything (mic, sockets, player) whenever the panel closes
  // or the selected call changes - never leave a live socket/mic open in
  // the background.
  // Intentionally only re-runs its cleanup on call.id change - teardownAll/
  // teardownListen/teardownInject are stable closures over refs/state
  // setters, not real dependencies (this project's eslint config does not
  // enable react-hooks/exhaustive-deps, so no suppression comment is
  // needed here).
  useEffect(() => {
    return () => teardownAll();
  }, [call.id]);

  function teardownListen() {
    listenSocketRef.current?.socket.close();
    void listenSocketRef.current?.player.close();
    listenSocketRef.current = null;
  }
  function teardownInject() {
    micStop?.();
    setMicStop(null);
    injectSocketRef.current?.close();
    injectSocketRef.current = null;
  }
  function teardownAll() {
    teardownListen();
    teardownInject();
  }

  async function handleListen() {
    setError(null);
    try {
      const result: ListenResult = await listenMutation.mutateAsync(call.id);
      const stripTag = result.engine === 'pipecat';
      listenSocketRef.current = openListenSocket(result.ws_url, result.token, stripTag);
      setMode('listening');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not start listening.');
    }
  }

  async function handleWhisperVapiSend() {
    if (!whisperText.trim()) return;
    setError(null);
    try {
      await whisperMutation.mutateAsync({ callId: call.id, text: whisperText, action: 'message' });
      setWhisperText('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not send whisper message.');
    }
  }

  async function handleWhisperPipecatStart() {
    setError(null);
    try {
      const result = await whisperMutation.mutateAsync({ callId: call.id, action: 'start' });
      if (!result.ws_url) throw new Error('No whisper channel URL returned.');
      const url = result.token ? `${result.ws_url}?token=${encodeURIComponent(result.token)}` : result.ws_url;
      const socket = new WebSocket(url);
      injectSocketRef.current = socket;
      const stop = await startMicPcmCapture((chunk) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(chunk.buffer);
      });
      setMicStop(() => stop);
      setMode('whispering');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : 'Could not start whisper.');
    }
  }

  async function handleWhisperStop() {
    teardownInject();
    try {
      await whisperMutation.mutateAsync({ callId: call.id, action: 'end' });
    } catch {
      // best-effort - the mic/socket are already torn down locally either way
    }
    setMode('idle');
  }

  async function handleBargeStart() {
    setError(null);
    try {
      const result: BargeResult = await bargeMutation.mutateAsync({ callId: call.id, action: 'start' });
      if (result.ws_url) {
        const stripTag = result.engine === 'pipecat';
        listenSocketRef.current = openListenSocket(result.ws_url, result.token, stripTag);
        if (result.engine === 'pipecat') {
          // pipecat's /barge socket is bidirectional - the SAME socket
          // carries both tapped audio (handled by openListenSocket above)
          // and this client's outgoing mic frames.
          injectSocketRef.current = listenSocketRef.current.socket;
          const stop = await startMicPcmCapture((chunk) => {
            if (injectSocketRef.current?.readyState === WebSocket.OPEN) injectSocketRef.current.send(chunk.buffer);
          });
          setMicStop(() => stop);
        }
      }
      setMode('barged_in');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not barge in.');
    }
  }

  async function handleBargeStop() {
    teardownAll();
    try {
      await bargeMutation.mutateAsync({ callId: call.id, action: 'end' });
    } catch {
      // best-effort
    }
    setMode('idle');
  }

  async function handleTransfer() {
    if (!call.transfer_destination_e164) return;
    setError(null);
    try {
      await transferMutation.mutateAsync({ callId: call.id, destination_e164: call.transfer_destination_e164 });
      setShowTransferConfirm(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not initiate transfer.');
    }
  }

  async function handleEnd() {
    setError(null);
    try {
      await endMutation.mutateAsync(call.id);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not end this call.');
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-ink-900">{call.customer_number}</h2>
            <p className="text-sm text-ink-500">{call.ai_agent_name ?? 'Unassigned agent'} - {call.campaign_name ?? 'Manual call'}</p>
            <p className="text-sm text-ink-500">Voice: {call.voice_name ?? 'Default'}</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={STATE_TONE[mode]}>{STATE_LABEL[mode]}</Badge>
            <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {error && (
          <div className="px-6 pt-3">
            <Alert>{error}</Alert>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-b border-ink-200 px-6 py-3">
          {canListen && mode === 'idle' && (
            <Button variant="secondary" onClick={handleListen} disabled={listenMutation.isPending}>
              {listenMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Headphones className="h-4 w-4" />} Listen
            </Button>
          )}
          {mode === 'listening' && (
            <Button variant="secondary" onClick={() => { teardownListen(); setMode('idle'); }}>
              <Headphones className="h-4 w-4" /> Stop listening
            </Button>
          )}
          {canWhisper && mode === 'idle' && call.engine === 'pipecat' && (
            <Button variant="secondary" onClick={handleWhisperPipecatStart} disabled={whisperMutation.isPending}>
              <Mic className="h-4 w-4" /> Whisper
            </Button>
          )}
          {mode === 'whispering' && (
            <Button variant="secondary" onClick={handleWhisperStop}>
              <Mic className="h-4 w-4" /> Stop whisper
            </Button>
          )}
          {canBarge && (mode === 'idle' || mode === 'listening') && (
            <Button variant="secondary" onClick={handleBargeStart} disabled={bargeMutation.isPending}>
              <Users className="h-4 w-4" /> Barge in
            </Button>
          )}
          {mode === 'barged_in' && (
            <Button variant="danger" onClick={handleBargeStop}>
              <Users className="h-4 w-4" /> Leave call
            </Button>
          )}
          {canBarge && call.transfer_destination_e164 && (
            <Button variant="secondary" onClick={() => setShowTransferConfirm(true)} disabled={transferMutation.isPending}>
              <PhoneForwarded className="h-4 w-4" /> Transfer
            </Button>
          )}
          {canBarge && (
            <Button variant="danger" onClick={handleEnd} disabled={endMutation.isPending}>
              <PhoneOff className="h-4 w-4" /> End call
            </Button>
          )}
        </div>

        {canWhisper && call.engine === 'vapi' && (
          <div className="border-b border-ink-200 px-6 py-3">
            <p className="mb-2 text-xs text-ink-500">
              Vapi has no silent whisper-only channel - this message becomes real speech on the live call, audible to
              the caller (see routes/liveMonitor.ts for why).
            </p>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-md border border-ink-300 px-3 py-2 text-sm focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
                placeholder="Message for the AI to say on this call..."
                value={whisperText}
                onChange={(e) => setWhisperText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleWhisperVapiSend(); }}
              />
              <Button onClick={handleWhisperVapiSend} disabled={whisperMutation.isPending || !whisperText.trim()}>Send</Button>
            </div>
          </div>
        )}

        {showTransferConfirm && (
          <div className="border-b border-ink-200 bg-gold-50 px-6 py-3">
            <p className="text-sm text-ink-800">
              Transfer this call to <span className="font-mono font-semibold">{call.transfer_destination_e164}</span> - the
              campaign/agent's own configured number. This cannot be changed here.
            </p>
            <div className="mt-2 flex gap-2">
              <Button onClick={handleTransfer} disabled={transferMutation.isPending}>Confirm transfer</Button>
              <Button variant="ghost" onClick={() => setShowTransferConfirm(false)}>Cancel</Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <h3 className="mb-2 text-sm font-semibold text-ink-700">Live transcript</h3>
          {segments.length === 0 && <p className="text-sm text-ink-400">No transcript segments yet.</p>}
          <div className="space-y-2">
            {segments.map((s) => (
              <p key={s.segment_index} className="text-sm">
                <span className={s.speaker === 'ai' ? 'font-semibold text-ink-900' : 'font-semibold text-gold-700'}>
                  {speakerLabel(s.speaker, call.voice_name)}:
                </span>{' '}
                <span className="text-ink-700">{s.text}</span>
              </p>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
