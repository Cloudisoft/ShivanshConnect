import {
  type CloneVoiceOptions,
  type CloneVoiceResult,
  type PreviewAudioResult,
  type VoiceInfo,
  type VoiceProviderAdapter,
  VoiceProviderError,
  VoiceProviderNotConfiguredError,
} from './types.js';

const CARTESIA_API_BASE = 'https://api.cartesia.ai';
// Cartesia requires a dated version header on every request - see their
// API reference. Pinned rather than "latest" so behavior doesn't shift
// under us silently.
const CARTESIA_VERSION = '2024-06-10';
const DEFAULT_MODEL_ID = 'sonic-2';

interface CartesiaVoice {
  id: string;
  name: string;
  description?: string | null;
  language?: string | null;
  gender?: string | null;
}

function mapGender(raw: string | null | undefined): VoiceInfo['gender'] {
  const g = raw?.toLowerCase();
  if (g === 'male' || g === 'female') return g;
  if (g === 'neutral') return 'neutral';
  return 'unknown';
}

function toVoiceInfo(v: CartesiaVoice): VoiceInfo {
  return {
    providerVoiceId: v.id,
    name: v.name,
    gender: mapGender(v.gender),
    language: v.language ?? undefined,
    description: v.description ?? undefined,
    requiresExternalHosting: false,
  };
}

/**
 * Real Cartesia integration - a managed SaaS TTS + voice-cloning API,
 * using CARTESIA_API_KEY (or an org's own stored credential, see
 * lib/voice/index.ts) via fetch against the documented REST endpoints:
 *   GET  /voices                - list (paginated; we take the first page)
 *   GET  /voices/:id            - get one
 *   POST /tts/bytes             - synthesize (returns raw audio bytes)
 *   POST /voices/clone          - voice cloning (multipart: clip + name)
 * Every request carries X-API-Key and the dated Cartesia-Version header.
 * If no API key is configured, every method throws
 * VoiceProviderNotConfiguredError immediately - never fabricated voices
 * or audio.
 */
export class CartesiaProvider implements VoiceProviderAdapter {
  readonly key = 'cartesia' as const;
  readonly name = 'Cartesia';
  readonly requiresExternalHosting = false;
  readonly supportsCloning = true;
  private readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined = process.env.CARTESIA_API_KEY) {
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new VoiceProviderNotConfiguredError(
        'Cartesia is not connected for this organization. Add an API key under Voice Providers.',
      );
    }
    return this.apiKey;
  }

  private headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
    return { 'X-API-Key': apiKey, 'Cartesia-Version': CARTESIA_VERSION, ...extra };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${CARTESIA_API_BASE}/voices`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the Cartesia API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`Cartesia voice list request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as CartesiaVoice[] | { data: CartesiaVoice[] };
    const voices = Array.isArray(json) ? json : json.data ?? [];
    return voices.map(toVoiceInfo);
  }

  async getVoice(id: string): Promise<VoiceInfo> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${CARTESIA_API_BASE}/voices/${encodeURIComponent(id)}`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the Cartesia API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`Cartesia get-voice request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    return toVoiceInfo((await res.json()) as CartesiaVoice);
  }

  async previewVoice(id: string, sampleText: string): Promise<PreviewAudioResult> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${CARTESIA_API_BASE}/tts/bytes`, {
        method: 'POST',
        headers: this.headers(apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model_id: DEFAULT_MODEL_ID,
          transcript: sampleText,
          voice: { mode: 'id', id },
          output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
        }),
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the Cartesia API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`Cartesia text-to-speech request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType: 'audio/mpeg' };
  }

  async validateVoice(id: string): Promise<boolean> {
    try {
      await this.getVoice(id);
      return true;
    } catch (err) {
      if (err instanceof VoiceProviderNotConfiguredError) throw err;
      return false;
    }
  }

  async createVoice(options: CloneVoiceOptions): Promise<CloneVoiceResult> {
    const apiKey = this.requireKey();
    const form = new FormData();
    form.set('name', options.name);
    form.set('mode', 'similarity');
    form.set('enhance', 'true');
    if (options.description) form.set('description', options.description);
    form.set(
      'clip',
      new Blob([new Uint8Array(options.sampleAudio)], { type: options.sampleContentType }),
      options.sampleFileName,
    );

    let res: Response;
    try {
      res = await fetch(`${CARTESIA_API_BASE}/voices/clone`, {
        method: 'POST',
        headers: this.headers(apiKey),
        body: form,
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the Cartesia API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`Cartesia voice cloning request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { id: string };
    return { providerVoiceId: json.id, status: 'ready' };
  }

  async deleteVoice(id: string): Promise<void> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${CARTESIA_API_BASE}/voices/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.headers(apiKey),
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the Cartesia API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`Cartesia delete-voice request failed (${res.status}): ${body.slice(0, 500)}`);
    }
  }
}
