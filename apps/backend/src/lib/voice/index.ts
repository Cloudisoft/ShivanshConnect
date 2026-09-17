import { CartesiaProvider } from './cartesia.js';
import { ElevenLabsProvider } from './elevenlabs.js';
import { OmniVoiceProvider } from './omnivoice.js';
import { VoxCPMProvider } from './voxcpm.js';
import type { VoiceProviderAdapter, VoiceProviderKey } from './types.js';

export * from './types.js';
export { ElevenLabsProvider } from './elevenlabs.js';
export { CartesiaProvider } from './cartesia.js';
export { OmniVoiceProvider } from './omnivoice.js';
export { VoxCPMProvider } from './voxcpm.js';

/** Static catalog metadata - mirrors the voice_providers table seed
 * (00000000000024_voices.sql) without a DB round-trip. */
export const VOICE_PROVIDER_CATALOG: { key: VoiceProviderKey; displayName: string; requiresExternalHosting: boolean }[] = [
  { key: 'elevenlabs', displayName: 'ElevenLabs', requiresExternalHosting: false },
  { key: 'cartesia', displayName: 'Cartesia', requiresExternalHosting: false },
  { key: 'omnivoice', displayName: 'OmniVoice (k2-fsa)', requiresExternalHosting: true },
  { key: 'voxcpm', displayName: 'VoxCPM (OpenBMB)', requiresExternalHosting: true },
];

/** Org-specific decrypted credentials, shaped per provider (see each
 * adapter's constructor). Passed in explicitly by the route layer after
 * decrypting voice_provider_credentials.encrypted_credentials - never
 * cached process-wide, since every org can have its own. */
export type VoiceProviderCredentials =
  | { api_key: string }
  | { endpoint_url: string; api_key: string };

let testOverrides: Partial<Record<VoiceProviderKey, VoiceProviderAdapter>> | null = null;

/**
 * Builds the adapter for a given provider key. When `credentials` is
 * omitted, each adapter falls back to its matching env var (useful for a
 * platform-level default/local dev, mirroring lib/llm/index.ts) - in
 * normal request handling routes always pass the org's own decrypted
 * credentials explicitly.
 */
export function createVoiceProviderAdapter(
  key: VoiceProviderKey,
  credentials?: VoiceProviderCredentials,
): VoiceProviderAdapter {
  if (testOverrides?.[key]) return testOverrides[key]!;

  switch (key) {
    case 'elevenlabs':
      return new ElevenLabsProvider(credentials && 'api_key' in credentials ? credentials.api_key : undefined);
    case 'cartesia':
      return new CartesiaProvider(credentials && 'api_key' in credentials ? credentials.api_key : undefined);
    case 'omnivoice':
      return new OmniVoiceProvider(
        credentials && 'endpoint_url' in credentials ? credentials.endpoint_url : undefined,
        credentials && 'api_key' in credentials ? credentials.api_key : undefined,
      );
    case 'voxcpm':
      return new VoxCPMProvider(
        credentials && 'endpoint_url' in credentials ? credentials.endpoint_url : undefined,
        credentials && 'api_key' in credentials ? credentials.api_key : undefined,
      );
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unknown voice provider key: ${_exhaustive as string}`);
    }
  }
}

/** Test-only hook to inject a fake adapter for a given provider key
 * without touching env vars or making real HTTP calls. */
export function __setVoiceProviderForTests(key: VoiceProviderKey, adapter: VoiceProviderAdapter | null): void {
  if (!testOverrides) testOverrides = {};
  if (adapter) testOverrides[key] = adapter;
  else delete testOverrides[key];
}
