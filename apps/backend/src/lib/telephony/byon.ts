import { isValidNormalizedPhone, normalizePhoneNumber } from '../phone.js';
import {
  type ImportNumberInput,
  type TelephonyNumberInfo,
  type TelephonyNumberProviderAdapter,
  type TelephonyNumberStatus,
  TelephonyProviderError,
  TelephonyProviderNotSupportedError,
} from './types.js';

/**
 * BYON ("Bring Your Own Number") is NOT a third-party API integration -
 * there is no BYON company or REST endpoint anywhere. It is a manual-entry
 * flow for a number the organization already controls outside this
 * platform (e.g. a number on their own SIP trunk, or one ported through
 * their own carrier via a process this platform is not part of). The org
 * declares the number's E.164 form and its own capability flags
 * (voice inbound/outbound, SMS) and optionally attaches SIP trunk
 * connection metadata (host/username/password - the password is
 * encrypted by the route layer with the same crypto helper Twilio/Telnyx
 * credentials use, before being stored inside phone_numbers.sip_trunk_
 * metadata).
 *
 * Because there is no provider API:
 *  - connect(), disconnect(), listNumbers() and getNumberStatus() all
 *    throw TelephonyProviderNotSupportedError - there is nothing to
 *    connect to, nothing to sync from, and no live status to poll. This
 *    is intentional and documented, not a stub: BYON's route path
 *    (POST /phone-numbers/import) never calls any of these four methods.
 *  - importNumber() does the only real work this adapter has: it
 *    validates the supplied E.164 format (via lib/phone.ts, the exact
 *    same normalization Phase 2's leads/DNC data uses) and hands back a
 *    TelephonyNumberInfo built entirely from what the org typed in - no
 *    external HTTP call is made, ever.
 *  - validateNumber() is real, local format validation (not a network
 *    call) - it exists so the frontend can get live E.164 validation
 *    feedback before submitting the import.
 */
export class BYONProvider implements TelephonyNumberProviderAdapter {
  readonly key = 'byon' as const;
  readonly name = 'Bring Your Own Number (BYON)';
  readonly isManualOnly = true;

  // Always "configured" - there are no credentials to be missing. The
  // manual-declaration flow works the moment an org fills out the form.
  get isConfigured(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    throw new TelephonyProviderNotSupportedError(this.name, 'connect');
  }

  async disconnect(): Promise<void> {
    throw new TelephonyProviderNotSupportedError(this.name, 'disconnect');
  }

  async listNumbers(): Promise<TelephonyNumberInfo[]> {
    throw new TelephonyProviderNotSupportedError(this.name, 'listNumbers');
  }

  async importNumber(input: ImportNumberInput): Promise<TelephonyNumberInfo> {
    if (!input.e164) {
      throw new TelephonyProviderError('An E.164 phone number is required to declare a BYON number.');
    }
    const normalized = normalizePhoneNumber(input.e164);
    if (!isValidNormalizedPhone(normalized)) {
      throw new TelephonyProviderError(`"${input.e164}" is not a valid, dialable phone number: ${normalized.reason}`);
    }
    if (!input.capabilities) {
      throw new TelephonyProviderError('At least one capability (voice inbound/outbound or SMS) must be declared.');
    }
    return {
      providerNumberId: null,
      phoneNumber: normalized.e164,
      friendlyName: input.friendlyName ?? null,
      capabilities: input.capabilities,
    };
  }

  async validateNumber(e164: string): Promise<boolean> {
    return isValidNormalizedPhone(normalizePhoneNumber(e164));
  }

  async getNumberStatus(): Promise<TelephonyNumberStatus> {
    throw new TelephonyProviderNotSupportedError(this.name, 'getNumberStatus');
  }
}
