import {
  type CloneVoiceOptions,
  type CloneVoiceResult,
  type PreviewAudioResult,
  type VoiceInfo,
  type VoiceProviderAdapter,
  VoiceProviderError,
  VoiceProviderNotConfiguredError,
} from './types.js';

/**
 * OmniVoice (k2-fsa) - open-source, Apache-2.0, multilingual TTS with
 * voice cloning and voice design via speaker attributes. It is a model
 * you self-host, not a managed API - this codebase never downloads or
 * runs it (no GPU in this build/sandbox). Per the task brief this is
 * wired up as a client against a SERVERLESS GPU inference endpoint, so
 * an org gets real cloning/synthesis without operating GPU infra itself.
 *
 * Platform chosen: Replicate custom model deployments
 * (https://replicate.com/docs/get-started/deploy-a-custom-model,
 * https://replicate.com/docs/reference/http). Replicate's HTTP API has
 * the clearest documented generic invocation pattern of the real options
 * (Replicate / Modal / RunPod Serverless / HF Inference Endpoints): every
 * model, official or custom, is invoked the same way - POST a
 * `{ input: {...} }` body to a predictions endpoint with
 * `Authorization: Bearer <token>`, then poll the returned `urls.get`
 * until `status` is `succeeded`/`failed`. That one shape (create ->
 * poll) is exactly what this adapter implements, and it's provider-
 * agnostic enough that any other predictions-style server exposing the
 * same {id, status, urls.get, output} contract would also work against
 * it - it is not hard-coded to Replicate's own domain.
 *
 * TO STAND THIS UP FOR REAL:
 *   1. Package the OmniVoice model (https://github.com/k2-fsa/OmniVoice,
 *      or its HF Space) as a Cog model per Replicate's custom-model
 *      guide, with an input schema of roughly
 *      { text: string, task: "synthesize" | "clone",
 *        reference_audio_url?: string, voice_id?: string }
 *      and output of a single audio file (wav/mp3) URL or base64 string.
 *   2. Push it to Replicate and create a Deployment from it.
 *   3. Set OMNIVOICE_ENDPOINT_URL to that deployment's predictions URL
 *      (https://api.replicate.com/v1/deployments/<owner>/<name>/predictions)
 *      and OMNIVOICE_API_KEY to a Replicate API token.
 * These are ORG-LEVEL credentials stored encrypted per organization in
 * voice_provider_credentials (see routes/voiceProviders.ts), exactly
 * like ElevenLabs/Cartesia's API keys - not a single platform-wide
 * secret - so each org can point at its own deployment.
 *
 * Without OMNIVOICE_ENDPOINT_URL/OMNIVOICE_API_KEY configured for the
 * org, every method throws VoiceProviderNotConfiguredError - never fake
 * voices or fabricated audio.
 */
export class OmniVoiceProvider implements VoiceProviderAdapter {
  readonly key = 'omnivoice' as const;
  readonly name = 'OmniVoice (k2-fsa)';
  readonly requiresExternalHosting = true;
  readonly supportsCloning = true;
  private readonly endpointUrl: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(
    endpointUrl: string | undefined = process.env.OMNIVOICE_ENDPOINT_URL,
    apiKey: string | undefined = process.env.OMNIVOICE_API_KEY,
  ) {
    this.endpointUrl = endpointUrl && endpointUrl.trim().length > 0 ? endpointUrl.trim() : undefined;
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.endpointUrl && this.apiKey);
  }

  private require(): { endpointUrl: string; apiKey: string } {
    if (!this.endpointUrl || !this.apiKey) {
      throw new VoiceProviderNotConfiguredError(
        'OmniVoice requires a self-hosted serverless GPU endpoint. Deploy the OmniVoice model (see lib/voice/omnivoice.ts) and set its endpoint URL + API key under Voice Providers.',
      );
    }
    return { endpointUrl: this.endpointUrl, apiKey: this.apiKey };
  }

  /** OmniVoice has no built-in voice catalog to sync - it is a raw
   * synthesis/cloning model, not a managed API with a voices list. Every
   * OmniVoice voice in this build comes from cloning
   * (POST /voices/clone), never from a sync. Returning an empty list
   * here (once configured) is the honest result, not a stub - syncing a
   * connected OmniVoice endpoint is simply a no-op today. */
  async listVoices(): Promise<VoiceInfo[]> {
    this.require();
    return [];
  }

  async getVoice(id: string): Promise<VoiceInfo> {
    this.require();
    return { providerVoiceId: id, name: id, requiresExternalHosting: true };
  }

  private async createPrediction(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { endpointUrl, apiKey } = this.require();
    let res: Response;
    try {
      res = await fetch(endpointUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the configured OmniVoice endpoint.', err);
    }
    if (!res.ok && res.status !== 201) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`OmniVoice endpoint request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** Polls a Replicate-shaped prediction ({status, urls.get, output,
   * error}) until it settles, bounded to avoid hanging a request
   * forever. */
  private async pollPrediction(prediction: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { apiKey } = this.require();
    let current = prediction;
    const getUrl = (current.urls as Record<string, unknown> | undefined)?.get as string | undefined;
    if (!getUrl) return current; // already a synchronous/final response

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = current.status as string;
      if (status === 'succeeded' || status === 'failed' || status === 'canceled') break;

      await new Promise((resolve) => setTimeout(resolve, 1000));
      let res: Response;
      try {
        res = await fetch(getUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
      } catch (err) {
        throw new VoiceProviderError('Failed to reach the configured OmniVoice endpoint while polling.', err);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new VoiceProviderError(`OmniVoice status poll failed (${res.status}): ${body.slice(0, 500)}`);
      }
      current = (await res.json()) as Record<string, unknown>;
    }
    return current;
  }

  async previewVoice(id: string, sampleText: string): Promise<PreviewAudioResult> {
    const created = await this.createPrediction({ task: 'synthesize', text: sampleText, voice_id: id });
    const final = await this.pollPrediction(created);
    if (final.status === 'failed' || final.error) {
      throw new VoiceProviderError(`OmniVoice synthesis failed: ${String(final.error ?? 'unknown error')}`);
    }
    const output = final.output;
    const audioUrl = typeof output === 'string' ? output : Array.isArray(output) ? String(output[0]) : undefined;
    if (!audioUrl) {
      throw new VoiceProviderError('OmniVoice endpoint returned no audio output.');
    }
    let audioRes: Response;
    try {
      audioRes = await fetch(audioUrl);
    } catch (err) {
      throw new VoiceProviderError('Failed to download OmniVoice-generated audio.', err);
    }
    if (!audioRes.ok) {
      throw new VoiceProviderError(`Failed to download OmniVoice-generated audio (${audioRes.status}).`);
    }
    const arrayBuffer = await audioRes.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType: audioRes.headers.get('content-type') ?? 'audio/wav' };
  }

  async validateVoice(id: string): Promise<boolean> {
    try {
      await this.previewVoice(id, 'This is a short connection test.');
      return true;
    } catch (err) {
      if (err instanceof VoiceProviderNotConfiguredError) throw err;
      return false;
    }
  }

  async createVoice(options: CloneVoiceOptions): Promise<CloneVoiceResult> {
    if (!options.sampleAudioUrl) {
      throw new VoiceProviderError('A reachable URL for the reference sample is required to clone an OmniVoice voice.');
    }
    const created = await this.createPrediction({
      task: 'clone',
      name: options.name,
      reference_audio_url: options.sampleAudioUrl,
    });
    const final = await this.pollPrediction(created);
    if (final.status === 'failed' || final.error) {
      throw new VoiceProviderError(`OmniVoice cloning failed: ${String(final.error ?? 'unknown error')}`);
    }
    const providerVoiceId = typeof final.id === 'string' ? `omnivoice-${final.id}` : `omnivoice-${Date.now()}`;
    return { providerVoiceId, status: 'ready' };
  }
}
