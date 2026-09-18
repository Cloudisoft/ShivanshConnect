import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptCredentials } from '../crypto/credentials.js';
import { TelnyxSmsProvider } from './telnyxSms.js';
import { TwilioSmsProvider } from './twilioSms.js';
import { type SmsProviderAdapter, type SmsProviderKey, SmsProviderNotConfiguredError } from './types.js';

export * from './types.js';
export { TwilioSmsProvider } from './twilioSms.js';
export { TelnyxSmsProvider } from './telnyxSms.js';

let testOverrides: Partial<Record<SmsProviderKey, SmsProviderAdapter>> | null = null;

/** Test-only hook to inject a fake SMS adapter, same pattern as
 * lib/telephony/index.ts's __setTelephonyProviderForTests. */
export function __setSmsProviderForTests(key: SmsProviderKey, adapter: SmsProviderAdapter | null): void {
  if (!testOverrides) testOverrides = {};
  if (adapter) testOverrides[key] = adapter;
  else delete testOverrides[key];
}

/**
 * Builds an SMS adapter for `providerKey` using the org's decrypted
 * credentials, passed in explicitly. There is no separate "SMS
 * credentials" table - the route/dispatcher layer resolves credentials
 * with `resolveSmsAdapterForOrg()` below, which reads the exact same
 * phone_number_provider_credentials row Phase 5's telephony adapters use.
 */
export function createSmsProviderAdapter(providerKey: SmsProviderKey, credentials?: Record<string, string>): SmsProviderAdapter {
  if (testOverrides?.[providerKey]) return testOverrides[providerKey]!;
  switch (providerKey) {
    case 'twilio':
      return new TwilioSmsProvider(credentials?.account_sid, credentials?.auth_token);
    case 'telnyx':
      return new TelnyxSmsProvider(credentials?.api_key);
    default: {
      const _exhaustive: never = providerKey;
      throw new Error(`Unknown SMS provider key: ${_exhaustive as string}`);
    }
  }
}

/**
 * Resolves and constructs the SMS adapter for a given org + provider key
 * by decrypting the SAME phone_number_provider_credentials row Phase 5's
 * Twilio/Telnyx telephony adapters read (see this module's header
 * comment - there is deliberately no separate SMS credential store).
 * Throws SmsProviderNotConfiguredError if the org never connected that
 * provider, or if BYON is passed (BYON has no provider API, no SMS
 * sending capability - see lib/telephony/byon.ts).
 */
export async function resolveSmsAdapterForOrg(
  supabase: SupabaseClient,
  organizationId: string,
  providerKey: string,
  encryptionKey?: string,
): Promise<SmsProviderAdapter> {
  if (providerKey !== 'twilio' && providerKey !== 'telnyx') {
    throw new SmsProviderNotConfiguredError('SMS sending is only supported for numbers on Twilio or Telnyx (BYON has no provider API).');
  }
  const { data: credRow, error } = await supabase
    .from('phone_number_provider_credentials')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('provider_key', providerKey)
    .maybeSingle();
  if (error) throw error;
  if (!credRow || credRow.status !== 'connected') {
    throw new SmsProviderNotConfiguredError(`${providerKey === 'twilio' ? 'Twilio' : 'Telnyx'} is not connected for this organization.`);
  }
  const decrypted = decryptCredentials<Record<string, string>>(credRow.encrypted_credentials, encryptionKey);
  return createSmsProviderAdapter(providerKey, decrypted);
}
