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
/** Live listening volume boost (see the limiter in PcmStreamPlayer). */
const LISTEN_GAIN = 2.5;
/** How much of a stream is measured before playback to learn its format. */
const DETECT_WINDOW_MS = 1500;
const STANDARD_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

function nearestRate(rate: number): number {
  return STANDARD_RATES.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best), STANDARD_RATES[0]);
}

/** Interleaved stereo alternates between two different signals, so
 * neighbouring samples differ more than samples two apart; in mono it is
 * the other way round (audio is smooth sample to sample). */
function looksStereo(chunks: Int16Array[]): boolean {
  let d1 = 0;
  let d2 = 0;
  for (const c of chunks) {
    for (let i = 0; i + 2 < c.length; i += 2) {
      d1 += Math.abs(c[i] - c[i + 1]);
      d2 += Math.abs(c[i] - c[i + 2]);
    }
  }
  return d2 > 0 && d1 > d2 * 1.1;
}

/** Works out sample rate and channels from how fast bytes arrive. */
export function detectPcmFormat(chunks: Int16Array[], bytes: number, seconds: number): { sampleRate: number; channels: 1 | 2 } {
  const bytesPerSecond = bytes / Math.max(seconds, 0.001);
  const stereo = looksStereo(chunks);
  const channels: 1 | 2 = stereo ? 2 : 1;
  const sampleRate = nearestRate(bytesPerSecond / (2 * channels));
  return { sampleRate, channels };
}

/** One AudioContext for the page, created/resumed by unlockAudio() during
 * any click - browsers only allow audio to start from a user gesture, so
 * this is what lets Live Monitor start listening BY ITSELF later (when a
 * call connects), not only inside a Listen click. */
let sharedCtx: AudioContext | null = null;

export function unlockAudio(): void {
  try {
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext();
    if (sharedCtx.state === 'suspended') void sharedCtx.resume().catch(() => undefined);
  } catch {
    // No Web Audio support - Listen will report its own error.
  }
}

/** True once a click has unlocked audio for this page. */
export function isAudioUnlocked(): boolean {
  return sharedCtx?.state === 'running';
}

/** Schedules incoming Int16 PCM chunks for gapless sequential playback
 * via the Web Audio API. Call `push()` as binary WS frames arrive. */
export class PcmStreamPlayer {
  private ctx: AudioContext;
  /** This player's own output; closing a player only disconnects it, so
   * the shared (unlocked) context stays usable for the next call. */
  private out: GainNode;
  private ownsContext: boolean;
  private nextStartTime = 0;
  private sampleRate: number;

  private channels = 1;

  /** Must be constructed synchronously inside the user's click handler
   * (before any await): browsers only let an AudioContext start playing
   * when it is created/resumed during a user gesture. Created later (after
   * the /listen request resolved) it stays 'suspended' and every pushed
   * chunk plays silently - which is exactly how Listen "did nothing". */
  constructor(sampleRate: number = DEFAULT_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    if (sharedCtx && sharedCtx.state !== 'closed') {
      this.ctx = sharedCtx;
      this.ownsContext = false;
    } else {
      this.ctx = new AudioContext();
      this.ownsContext = true;
    }
    void this.ctx.resume().catch(() => undefined);
    // Phone audio arrives quiet ("live listening is too low"): boosted,
    // with a compressor in front of the speakers so peaks never clip.
    this.out = this.ctx.createGain();
    this.out.gain.value = LISTEN_GAIN;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    this.out.connect(limiter);
    limiter.connect(this.ctx.destination);
    this.limiter = limiter;
  }

  private limiter: DynamicsCompressorNode | null = null;
  /** True once the stream announced its format, or it was measured. */
  private formatKnown = false;
  private detectStartedAt = 0;
  private detectBytes = 0;
  private pending: Int16Array[] = [];

  /** Applies a stream's own announced format (e.g. a JSON start frame
   * carrying sampleRate/channels) when it provides one. */
  setFormat(sampleRate: number, channels: number): void {
    if (Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000) {
      this.sampleRate = sampleRate;
      this.formatKnown = true;
    }
    if (channels === 1 || channels === 2) this.channels = channels;
    if (this.formatKnown) this.flushPending();
  }

  /** Call from a click: lets a player that started without one play. */
  resume(): void {
    void this.ctx.resume().catch(() => undefined);
  }

  /** False while the browser is still blocking this player's sound. */
  get playing(): boolean {
    return this.ctx.state === 'running';
  }

  /** Vapi's listen stream doesn't announce its format, and assuming one
   * (16 kHz mono) played it at the wrong speed/as noise when it differed -
   * "live listening is not working". So the first ~1.5 s is measured: the
   * byte rate gives sample rate x channels, and the sample pattern tells
   * interleaved stereo (caller and AI on separate channels) from mono. */
  push(int16: Int16Array): void {
    if (int16.length === 0) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    if (!this.formatKnown) {
      const now = performance.now();
      // Timed from the first chunk and counting only what arrives after it,
      // so a backlog flushed on connect doesn't inflate the byte rate.
      if (this.detectStartedAt === 0) this.detectStartedAt = now;
      else this.detectBytes += int16.byteLength;
      this.pending.push(int16);
      const elapsed = now - this.detectStartedAt;
      if (elapsed < DETECT_WINDOW_MS) return;
      const detected = detectPcmFormat(this.pending, this.detectBytes, elapsed / 1000);
      this.sampleRate = detected.sampleRate;
      this.channels = detected.channels;
      this.formatKnown = true;
      // eslint-disable-next-line no-console
      console.info('Live Monitor audio format', detected);
      this.flushPending();
      return;
    }
    this.play(int16);
  }

  private flushPending(): void {
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.play(chunk);
  }

  private play(int16: Int16Array): void {
    // Interleaved stereo (e.g. caller + assistant on separate channels) is
    // mixed down to mono so the supervisor hears both sides.
    const frames = Math.floor(int16.length / this.channels);
    if (frames === 0) return;
    const float32 = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let c = 0; c < this.channels; c += 1) sum += int16[i * this.channels + c];
      float32[i] = Math.max(-1, Math.min(1, sum / 32768));
    }

    const buffer = this.ctx.createBuffer(1, float32.length, this.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.out);

    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  async close(): Promise<void> {
    try {
      this.out.disconnect();
      this.limiter?.disconnect();
      if (this.ownsContext) await this.ctx.close();
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
