import { BYONProvider } from './byon.js';
import { TelnyxProvider } from './telnyx.js';
import { TwilioProvider } from './twilio.js';
import type { TelephonyNumberProviderAdapter, TelephonyProviderKey } from './types.js';

export * from './types.js';
export { TwilioProvider } from './twilio.js';
export { TelnyxProvider } from './telnyx.js';
export { BYONProvider } from './byon.js';

/** Static catalog metadata - mirrors the phone_number_providers table
 * seed (00000000000026_phone_numbers.sql) without a DB round-trip. */
export const TELEPHONY_PROVIDER_CATALOG: { key: TelephonyProviderKey; displayName: string; isManualOnly: boolean }[] = [
  { key: 'twilio', displayName: 'Twilio', isManualOnly: false },
  { key: 'telnyx', displayName: 'Telnyx', isManualOnly: false },
  { key: 'byon', displayName: 'Bring Your Own Number (BYON)', isManualOnly: true },
];

/** Org-specific decrypted credentials, shaped per provider (see each
 * adapter's constructor). Passed in explicitly by the route layer after
 * decrypting phone_number_provider_credentials.encrypted_credentials -
 * never cached process-wide, since every org can have its own. BYON never
 * has a value here. */
export type TelephonyProviderCredentials = { account_sid: string; auth_token: string } | { api_key: string };

let testOverrides: Partial<Record<TelephonyProviderKey, TelephonyNumberProviderAdapter>> | null = null;

/**
 * Builds the adapter for a given provider key. When `credentials` is
 * omitted, Twilio/Telnyx fall back to their matching env var (useful for a
 * platform-level default/local dev, mirroring lib/voice/index.ts) - in
 * normal request handling routes always pass the org's own decrypted
 * credentials explicitly. BYON ignores credentials entirely (it has none).
 */
export function createTelephonyProviderAdapter(
  key: TelephonyProviderKey,
  credentials?: TelephonyProviderCredentials,
): TelephonyNumberProviderAdapter {
  if (testOverrides?.[key]) return testOverrides[key]!;

  switch (key) {
    case 'twilio':
      return new TwilioProvider(
        credentials && 'account_sid' in credentials ? credentials.account_sid : undefined,
        credentials && 'auth_token' in credentials ? credentials.auth_token : undefined,
      );
    case 'telnyx':
      return new TelnyxProvider(credentials && 'api_key' in credentials ? credentials.api_key : undefined);
    case 'byon':
      return new BYONProvider();
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unknown telephony provider key: ${_exhaustive as string}`);
    }
  }
}

/** Test-only hook to inject a fake adapter for a given provider key
 * without touching env vars or making real HTTP calls. */
export function __setTelephonyProviderForTests(key: TelephonyProviderKey, adapter: TelephonyNumberProviderAdapter | null): void {
  if (!testOverrides) testOverrides = {};
  if (adapter) testOverrides[key] = adapter;
  else delete testOverrides[key];
}
