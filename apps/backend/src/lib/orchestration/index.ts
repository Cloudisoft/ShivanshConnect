import { PipecatProvider } from './pipecat.js';
import { VapiProvider } from './vapi.js';
import type { CallOrchestrationProvider, CallOrchestrationProviderKey } from './types.js';

export * from './types.js';
export * from './callStateMachine.js';
export { VapiProvider } from './vapi.js';
export { PipecatProvider } from './pipecat.js';

/** Org-specific decrypted credentials, shaped per engine. Passed in
 * explicitly by the route layer after decrypting
 * vapi_credentials.encrypted_credentials - never cached process-wide,
 * since every org can have its own Vapi key. Pipecat has no per-org
 * credential of this kind - it is configured once, process-wide, via
 * PIPECAT_SERVICE_URL (the self-hosted service's own deployment). */
export type OrchestrationProviderCredentials = { api_key: string };

let testOverrides: Partial<Record<CallOrchestrationProviderKey, CallOrchestrationProvider>> | null = null;

export function createOrchestrationProvider(
  key: CallOrchestrationProviderKey,
  credentials?: OrchestrationProviderCredentials,
): CallOrchestrationProvider {
  if (testOverrides?.[key]) return testOverrides[key]!;

  switch (key) {
    case 'vapi':
      return new VapiProvider(credentials?.api_key);
    case 'pipecat':
      return new PipecatProvider();
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unknown call orchestration engine key: ${_exhaustive as string}`);
    }
  }
}

/** Test-only hook to inject a fake adapter for a given engine key without
 * touching env vars or making real HTTP calls. */
export function __setOrchestrationProviderForTests(key: CallOrchestrationProviderKey, adapter: CallOrchestrationProvider | null): void {
  if (!testOverrides) testOverrides = {};
  if (adapter) testOverrides[key] = adapter;
  else delete testOverrides[key];
}
