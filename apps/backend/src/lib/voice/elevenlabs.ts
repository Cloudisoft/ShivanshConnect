import {
  type CloneVoiceOptions,
  type CloneVoiceResult,
  type PreviewAudioResult,
  type VoiceInfo,
  type VoiceProviderAdapter,
  VoiceProviderError,
  VoiceProviderNotConfiguredError,
} from './types.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  description?: string | null;
}

function mapGender(labels: Record<string, string> | undefined): VoiceInfo['gender'] {
  const raw = labels?.gender?.toLowerCase();
  if (raw === 'male' || raw === 'female') return raw;
  if (raw === 'neutral' || raw === 'non-binary') return 'neutral';
  return 'unknown';
}

function toVoiceInfo(v: ElevenLabsVoice): VoiceInfo {
  return {
    providerVoiceId: v.voice_id,
    name: v.name,
    gender: mapGender(v.labels),
    language: v.labels?.language,
    accent: v.labels?.accent,
    description: v.description ?? undefined,
    requiresExternalHosting: false,
  };
}

/**
 * Real ElevenLabs integration - a managed SaaS TTS + voice-cloning API,
 * using ELEVENLABS_API_KEY (or an org's own stored credential, see
 * lib/voice/index.ts) via fetch against the documented REST endpoints:
 *   GET  /v1/voices                       - list
 *   GET  /v1/voices/:voice_id             - get one
 *   POST /v1/text-to-speech/:voice_id     - synthesize (returns audio/mpeg bytes)
 *   POST /v1/voices/add                   - instant voice cloning (multipart)
 *   DELETE /v1/voices/:voice_id
 * If no API key is configured, every method throws
 * VoiceProviderNotConfiguredError immediately - never fabricated voices
 * or audio.
 */
export class ElevenLabsProvider implements VoiceProviderAdapter {
  readonly key = 'elevenlabs' as const;
  readonly name = 'ElevenLabs';
  readonly requiresExternalHosting = false;
  readonly supportsCloning = true;
  private readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined = process.env.ELEVENLABS_API_KEY) {
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new VoiceProviderNotConfiguredError(
        'ElevenLabs is not connected for this organization. Add an API key under Voice Providers.',
      );
    }
    return this.apiKey;
  }

  private headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
    return { 'xi-api-key': apiKey, ...extra };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${ELEVENLABS_API_BASE}/voices`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the ElevenLabs API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`ElevenLabs voice list request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { voices: ElevenLabsVoice[] };
    return (json.voices ?? []).map(toVoiceInfo);
  }

  async getVoice(id: string): Promise<VoiceInfo> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(id)}`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the ElevenLabs API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`ElevenLabs get-voice request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    return toVoiceInfo((await res.json()) as ElevenLabsVoice);
  }

  async previewVoice(id: string, sampleText: string): Promise<PreviewAudioResult> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: this.headers(apiKey, { 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
        body: JSON.stringify({ text: sampleText, model_id: 'eleven_multilingual_v2' }),
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the ElevenLabs API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`ElevenLabs text-to-speech request failed (${res.status}): ${body.slice(0, 500)}`);
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
    if (options.description) form.set('description', options.description);
    form.set(
      'files',
      new Blob([new Uint8Array(options.sampleAudio)], { type: options.sampleContentType }),
      options.sampleFileName,
    );

    let res: Response;
    try {
      res = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
        method: 'POST',
        headers: this.headers(apiKey),
        body: form,
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the ElevenLabs API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`ElevenLabs voice cloning request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { voice_id: string };
    return { providerVoiceId: json.voice_id, status: 'ready' };
  }

  async deleteVoice(id: string): Promise<void> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.headers(apiKey),
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the ElevenLabs API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`ElevenLabs delete-voice request failed (${res.status}): ${body.slice(0, 500)}`);
    }
  }
}
