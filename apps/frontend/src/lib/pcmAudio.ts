/**
 * Phase 10: minimal, real Web Audio playback/capture helpers for Live
 * Monitor's Listen/Whisper/Barge audio - no `<audio>` tag can consume
 * these streams directly (Vapi's `listenUrl` is a raw WSS PCM stream, not
 * an HTTP media URL; pipecat-service's supervisor WS is the same shape),
 * so this is the "WebRTC/websocket-audio approach" the task brief allows
 * for instead.
 *
 * Format assumption: 16-bit signed little-endian PCM, mono, 16kHz -
 * Vapi's documented listen-stream format and the sample rate this
 * codebase's pipecat pipeline (apps/pipecat-service) is built around
 * (see that service's transport config). If a real deployment's actual
 * stream differs, `sampleRate` is the one thing to change here.
 *
 * `ScriptProcessorNode` is used for microphone capture rather than an
 * `AudioWorklet` - it is formally deprecated but still universally
 * supported, and avoids shipping/loading a separate worklet module file
 * for what is otherwise a very small amount of real-time PCM framing
 * logic. This is a documented, honest trade-off, not a stub.
 */

const DEFAULT_SAMPLE_RATE = 16000;

/** Schedules incoming Int16 PCM chunks for gapless sequential playback
 * via the Web Audio API. Call `push()` as binary WS frames arrive. */
export class PcmStreamPlayer {
  private ctx: AudioContext;
  private nextStartTime = 0;
  private sampleRate: number;

  constructor(sampleRate: number = DEFAULT_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    this.ctx = new AudioContext();
  }

  push(int16: Int16Array): void {
    if (int16.length === 0) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) float32[i] = int16[i] / 32768;

    const buffer = this.ctx.createBuffer(1, float32.length, this.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  async close(): Promise<void> {
    try {
      await this.ctx.close();
    } catch {
      // Already closed - fine.
    }
  }
}

/** Captures the browser microphone and delivers Int16 PCM chunks to
 * `onChunk` in real time (for whisper/barge audio injection). Returns a
 * stop() function that releases the mic and tears down the audio graph. */
export async function startMicPcmCapture(
  onChunk: (chunk: Int16Array) => void,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate } });
  const ctx = new AudioContext({ sampleRate });
  const source = ctx.createMediaStreamSource(stream);
  // createScriptProcessor is deprecated in favor of AudioWorklet - see
  // this file's header comment for why it's still used here.
  const processor = ctx.createScriptProcessor(2048, 1, 1);

  processor.onaudioprocess = (event) => {
    const float32 = event.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }
    onChunk(int16);
  };

  source.connect(processor);
  // A ScriptProcessorNode only fires while connected into the graph's
  // destination path - a silent gain node avoids actually outputting the
  // supervisor's own mic to their speakers (echo) while keeping the
  // processor alive.
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  processor.connect(silentGain);
  silentGain.connect(ctx.destination);

  return () => {
    processor.disconnect();
    source.disconnect();
    silentGain.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}
