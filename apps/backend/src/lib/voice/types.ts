/**
 * Phase 4: voice provider abstraction (master spec sections 27/28/29).
 *
 * Mirrors lib/llm/types.ts's shape (adapter interface + typed
 * "not configured" vs "provider error" exceptions that routes map to
 * honest, never-fabricated API responses) but for text-to-speech/voice
 * providers, and with one structural difference the LLM adapter didn't
 * need: credentials are per-organization here (each org connects its own
 * ElevenLabs/Cartesia API key, or its own OmniVoice/VoxCPM endpoint), so
 * adapters are constructed fresh per request with the caller's decrypted
 * credentials rather than resolved once from a single process-wide env
 * var (see lib/voice/index.ts's createVoiceProviderAdapter). Each
 * adapter constructor still defaults to the matching env var when no
 * explicit credentials are passed, for parity with the LLM pattern and
 * for local/dev convenience.
 *
 * Four real adapters implement this interface:
 *  - ElevenLabsProvider, CartesiaProvider: managed SaaS REST APIs.
 *  - OmniVoiceProvider, VoxCPMProvider: open-source, GPU-only models that
 *    are NOT run in this codebase - they are called as HTTP clients
 *    against a serverless GPU endpoint the org deploys and configures
 *    itself (see each file's header comment for exactly which platform
 *    and why, and what "not configured" means for it).
 */

export type VoiceProviderKey = 'elevenlabs' | 'cartesia' | 'omnivoice' | 'voxcpm';

export type VoiceGender = 'male' | 'female' | 'neutral' | 'unknown';

export interface VoiceInfo {
  providerVoiceId: string;
  name: string;
  gender?: VoiceGender;
  language?: string;
  accent?: string;
  description?: string;
  /** Mirrors voice_providers.requires_external_hosting - true for
   * OmniVoice/VoxCPM. Carried on every VoiceInfo (not just the provider
   * record) so a route/UI reading a single voice never has to join back
   * to the provider catalog to know which badge to show. */
  requiresExternalHosting: boolean;
}

export interface PreviewAudioResult {
  audio: Buffer;
  contentType: string;
}

export interface CloneVoiceOptions {
  name: string;
  sampleAudio: Buffer;
  sampleFileName: string;
  sampleContentType: string;
  /** Reachable URL for the same sample audio (from StorageAdapter),
   * needed by providers (VoxCPM/OmniVoice) whose HTTP contract takes a
   * URL/data-URI reference rather than a raw multipart upload. */
  sampleAudioUrl?: string;
  description?: string;
}

export type CloneVoiceStatus = 'ready' | 'processing' | 'failed';

export interface CloneVoiceResult {
  providerVoiceId: string;
  status: CloneVoiceStatus;
}

/** ElevenLabs' real account "credits" are character quota, not currency
 * (see GET /v1/user/subscription) - a fundamentally different shape from
 * the dollar-denominated ProviderBalance telephony providers report, so
 * this is its own type rather than reusing that one. */
export interface VoiceProviderUsage {
  charactersUsed: number;
  characterLimit: number;
}

/** Thrown when a provider cannot run at all - no credentials/endpoint
 * configured for this org. Routes map this to an honest 422, exactly
 * like LlmNotConfiguredError. */
export class VoiceProviderNotConfiguredError extends Error {
  constructor(message = 'This voice provider is not configured.') {
    super(message);
    this.name = 'VoiceProviderNotConfiguredError';
  }
}

/** Thrown for any other provider-side failure (network error, non-2xx
 * response, malformed payload). */
export class VoiceProviderError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}

/** Thrown by createVoice() when a provider genuinely has no cloning
 * capability (per its real, documented API) - never faked. */
export class VoiceCloningNotSupportedError extends Error {
  constructor(providerName: string) {
    super(`${providerName} does not support voice cloning.`);
    this.name = 'VoiceCloningNotSupportedError';
  }
}

export interface VoiceProviderAdapter {
  readonly key: VoiceProviderKey;
  readonly name: string;
  readonly requiresExternalHosting: boolean;
  readonly isConfigured: boolean;
  readonly supportsCloning: boolean;

  listVoices(): Promise<VoiceInfo[]>;
  getVoice(id: string): Promise<VoiceInfo>;
  previewVoice(id: string, sampleText: string): Promise<PreviewAudioResult>;
  /** Confirms the given voice id is real and usable against this
   * provider/endpoint right now - used by both test-connection (with a
   * provider-chosen known-good id) and voice sync/validation. */
  validateVoice(id: string): Promise<boolean>;

  createVoice?(options: CloneVoiceOptions): Promise<CloneVoiceResult>;
  deleteVoice?(id: string): Promise<void>;
  /** Real character-quota usage, straight from the provider's own
   * billing API - only implemented where a real, documented endpoint
   * exists (ElevenLabs). Omitted (not just throwing) on every other
   * adapter, since most voice providers expose no such concept at all. */
  getUsage?(): Promise<VoiceProviderUsage>;
}
