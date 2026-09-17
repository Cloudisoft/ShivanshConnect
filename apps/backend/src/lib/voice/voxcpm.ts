import {
  type CloneVoiceOptions,
  type CloneVoiceResult,
  type PreviewAudioResult,
  type VoiceInfo,
  type VoiceProviderAdapter,
  VoiceProviderError,
  VoiceProviderNotConfiguredError,
} from './types.js';

const DEFAULT_MODEL = 'openbmb/VoxCPM2';

/**
 * VoxCPM (OpenBMB) - open-source, Apache-2.0, 48kHz diffusion TTS with
 * voice design + cloning, GPU-only (~8GB VRAM). Like OmniVoice, this
 * codebase never runs the model itself (no GPU here) - it is wired up as
 * an HTTP client against a serverless endpoint the org deploys.
 *
 * Platform/contract chosen: VoxCPM's own official integration is
 * vLLM-Omni (https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/),
 * which serves VoxCPM behind an OpenAI-COMPATIBLE `/v1/audio/speech`
 * endpoint (`vllm serve openbmb/VoxCPM2 --omni`). That's the real,
 * documented way to serve this model without writing custom inference
 * glue, so this adapter is simply an OpenAI-TTS-shaped client:
 *   POST {endpoint}/v1/audio/speech
 *   Authorization: Bearer <token>
 *   { model, input: <text>, voice?: <id>, response_format: "mp3" }
 * -> raw audio bytes in the response body (identical to OpenAI's own TTS
 * API contract). VoxCPM's documented `ref_audio` extension (a URL,
 * `data:` URI, or local path) is passed for cloned voices in place of
 * `voice`, since vLLM-Omni's OpenAI-compatible layer accepts it as an
 * additional field for reference-audio cloning.
 *
 * TO STAND THIS UP FOR REAL:
 *   1. On a GPU host or serverless GPU platform of the org's choice
 *      (Modal / RunPod Serverless / a Replicate custom deployment /
 *      HF Inference Endpoints all work, since the org is only running a
 *      container that exposes vLLM-Omni's HTTP server), run
 *      `vllm serve openbmb/VoxCPM2 --omni --port 8000` (see VoxCPM's own
 *      docs: https://voxcpm.readthedocs.io/en/latest/deployment/vllm_omni.html).
 *   2. Put that endpoint's base URL behind an auth-checking reverse
 *      proxy (vLLM-Omni itself does not enforce an API key), or use
 *      whatever bearer-token auth the chosen serverless platform fronts
 *      it with.
 *   3. Set VOXCPM_ENDPOINT_URL to the base URL and VOXCPM_API_KEY to the
 *      bearer token.
 * These are ORG-LEVEL credentials stored encrypted per organization in
 * voice_provider_credentials, exactly like OmniVoice's.
 *
 * Without VOXCPM_ENDPOINT_URL/VOXCPM_API_KEY configured for the org,
 * every method throws VoiceProviderNotConfiguredError - never fake
 * voices or fabricated audio.
 */
export class VoxCPMProvider implements VoiceProviderAdapter {
  readonly key = 'voxcpm' as const;
  readonly name = 'VoxCPM (OpenBMB)';
  readonly requiresExternalHosting = true;
  readonly supportsCloning = true;
  private readonly endpointUrl: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(
    endpointUrl: string | undefined = process.env.VOXCPM_ENDPOINT_URL,
    apiKey: string | undefined = process.env.VOXCPM_API_KEY,
  ) {
    this.endpointUrl = endpointUrl && endpointUrl.trim().length > 0 ? endpointUrl.trim().replace(/\/+$/, '') : undefined;
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.endpointUrl && this.apiKey);
  }

  private require(): { endpointUrl: string; apiKey: string } {
    if (!this.endpointUrl || !this.apiKey) {
      throw new VoiceProviderNotConfiguredError(
        'VoxCPM requires a self-hosted serverless GPU endpoint (vLLM-Omni). Deploy it (see lib/voice/voxcpm.ts) and set its endpoint URL + API key under Voice Providers.',
      );
    }
    return { endpointUrl: this.endpointUrl, apiKey: this.apiKey };
  }

  /** Like OmniVoice, VoxCPM has no built-in voice catalog - "voices" here
   * only exist as cloned reference audio. An empty list is the honest
   * result of a sync against a connected VoxCPM endpoint. */
  async listVoices(): Promise<VoiceInfo[]> {
    this.require();
    return [];
  }

  async getVoice(id: string): Promise<VoiceInfo> {
    this.require();
    return { providerVoiceId: id, name: id, requiresExternalHosting: true };
  }

  private async speech(body: Record<string, unknown>): Promise<PreviewAudioResult> {
    const { endpointUrl, apiKey } = this.require();
    let res: Response;
    try {
      res = await fetch(`${endpointUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: DEFAULT_MODEL, response_format: 'mp3', ...body }),
      });
    } catch (err) {
      throw new VoiceProviderError('Failed to reach the configured VoxCPM endpoint.', err);
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new VoiceProviderError(`VoxCPM speech request failed (${res.status}): ${errBody.slice(0, 500)}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
  }

  async previewVoice(id: string, sampleText: string): Promise<PreviewAudioResult> {
    // A provider_voice_id that looks like our own storage URL means this
    // is a cloned voice - pass it as ref_audio per VoxCPM's documented
    // cloning extension; otherwise treat it as a named preset voice.
    const isReferenceUrl = /^https?:\/\//.test(id) || id.startsWith('/voice-previews/');
    return this.speech(isReferenceUrl ? { input: sampleText, ref_audio: id } : { input: sampleText, voice: id });
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
      throw new VoiceProviderError('A reachable URL for the reference sample is required to clone a VoxCPM voice.');
    }
    // Confirm the endpoint + reference sample actually work end-to-end
    // with one short synthesis call before marking the voice ready -
    // never mark a clone ready without a real, successful provider call.
    await this.speech({ input: 'Voice clone verification.', ref_audio: options.sampleAudioUrl });
    return { providerVoiceId: options.sampleAudioUrl, status: 'ready' };
  }
}
