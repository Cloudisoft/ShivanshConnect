/**
 * Phase 5: telephony number provider abstraction (master spec sections
 * 32/33). Mirrors lib/voice/types.ts's shape (adapter interface + typed
 * "not configured" vs "provider error" exceptions that routes map to
 * honest, never-fabricated API responses), but for DIDs/phone numbers
 * instead of voices - and with credentials per-organization the same way
 * (each org connects its own Twilio Account SID/Auth Token or Telnyx API
 * key; adapters are constructed fresh per request with the caller's
 * decrypted credentials rather than resolved once process-wide).
 *
 * Three adapters implement this interface:
 *  - TwilioProvider, TelnyxProvider: real carrier REST APIs.
 *  - BYONProvider ("Bring Your Own Number"): NOT a third-party API at all.
 *    It is a manual-entry flow where the org declares a number it already
 *    controls (e.g. through its own SIP trunk, or a number ported via its
 *    own carrier outside this platform) and confirms E.164 format +
 *    capability flags itself. There is no "connect", "disconnect",
 *    "listNumbers" or "getNumberStatus" for BYON because there is no
 *    provider API to call - those four methods throw
 *    TelephonyProviderNotSupportedError with an explanation, and only
 *    importNumber()/validateNumber() do real work (local E.164 validation,
 *    never an external HTTP call). See byon.ts's header comment.
 */

export type TelephonyProviderKey = 'twilio' | 'telnyx' | 'byon';

export interface PhoneNumberCapabilities {
  voiceInbound: boolean;
  voiceOutbound: boolean;
  sms: boolean;
}

export interface TelephonyNumberInfo {
  /** Twilio SID / Telnyx id. Null only ever appears for a BYON-imported
   * number, which has no provider-assigned identifier. */
  providerNumberId: string | null;
  /** Strict E.164, e.g. "+14845551234". */
  phoneNumber: string;
  friendlyName: string | null;
  capabilities: PhoneNumberCapabilities;
}

export type TelephonyNumberStatus = 'active' | 'inactive';

/** What a provider inventory search accepts. `country` is a 2-letter ISO
 * code (e.g. "US"); `areaCode`/`contains` narrow the search the same way
 * Twilio's/Telnyx's own search UIs do. */
export interface AvailableNumberSearchParams {
  country: string;
  areaCode?: string;
  contains?: string;
  limit?: number;
}

/** A number from the provider's purchasable inventory - never a number
 * this org (or anyone) already owns. `monthlyPrice`/`currency` are null
 * when the provider's API did not return real pricing for this search -
 * never a guessed or hardcoded number. */
export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string | null;
  locality: string | null;
  region: string | null;
  capabilities: PhoneNumberCapabilities;
  monthlyPrice: number | null;
  currency: string | null;
}

/** What a BYON manual import (or a Twilio/Telnyx single-number import)
 * accepts. Twilio/Telnyx only ever use `providerNumberId`; BYON only ever
 * uses `e164` + `capabilities` (+ optional `sipTrunkMetadata`) - see each
 * adapter for which fields it actually reads. */
export interface ImportNumberInput {
  providerNumberId?: string;
  e164?: string;
  capabilities?: PhoneNumberCapabilities;
  friendlyName?: string | null;
  sipTrunkMetadata?: { host: string; username: string; password: string } | null;
}

/** Thrown when a provider cannot run at all - no credentials configured
 * for this org (Twilio/Telnyx). Routes map this to an honest 422, exactly
 * like VoiceProviderNotConfiguredError. */
export class TelephonyProviderNotConfiguredError extends Error {
  constructor(message = 'This telephony provider is not configured.') {
    super(message);
    this.name = 'TelephonyProviderNotConfiguredError';
  }
}

/** Thrown for any other provider-side failure (network error, non-2xx
 * response, malformed payload). */
export class TelephonyProviderError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'TelephonyProviderError';
  }
}

/** Thrown by BYON for the four methods that only make sense against a
 * real provider API, which BYON genuinely does not have. Never faked. */
export class TelephonyProviderNotSupportedError extends Error {
  constructor(providerName: string, method: string) {
    super(`${providerName} has no provider API, so ${method}() is not supported - it is a manual declaration only.`);
    this.name = 'TelephonyProviderNotSupportedError';
  }
}

export interface TelephonyNumberProviderAdapter {
  readonly key: TelephonyProviderKey;
  readonly name: string;
  readonly isManualOnly: boolean;
  readonly isConfigured: boolean;

  /** Validates the given credentials against the real provider API (a
   * lightweight authenticated read). Throws TelephonyProviderError if the
   * credentials are rejected, never silently "succeeds". */
  connect(credentials: Record<string, string>): Promise<void>;
  /** No persistent provider-side session exists to tear down for a
   * stateless REST API - this deletes nothing on the carrier's side (in
   * particular it NEVER releases a real phone number). It exists purely
   * so callers have a symmetric lifecycle method; see each adapter's
   * implementation comment for exactly what (if anything) it does. */
  disconnect(): Promise<void>;
  /** Lists every number the org actually owns on this provider account,
   * with real capabilities - never a fabricated number. */
  listNumbers(): Promise<TelephonyNumberInfo[]>;
  /** Imports a single number. Twilio/Telnyx: fetches it by provider id.
   * BYON: creates a declared number from manually supplied E.164 +
   * capabilities - no external call. */
  importNumber(input: ImportNumberInput): Promise<TelephonyNumberInfo>;
  /** Confirms the given E.164 number is valid - for Twilio/Telnyx, via a
   * real number-lookup API call; for BYON, via local E.164 format
   * validation only (no provider to ask). */
  validateNumber(e164: string): Promise<boolean>;
  /** Real-time status of a provider-owned number. Not supported for
   * BYON (see class doc). */
  getNumberStatus(providerNumberId: string): Promise<TelephonyNumberStatus>;
  /** Searches the provider's real purchasable inventory - never a
   * fabricated list. Not supported for BYON (no provider inventory to
   * search; it has no third-party API at all). */
  searchAvailableNumbers(params: AvailableNumberSearchParams): Promise<AvailableNumber[]>;
  /** Purchases (provisions) a specific number from the provider's
   * inventory - a real, billable action against the org's own connected
   * account. Not supported for BYON. */
  purchaseNumber(e164: string): Promise<TelephonyNumberInfo>;
}
