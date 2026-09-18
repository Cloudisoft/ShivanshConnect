/**
 * Phase 13: SMS provider adapter abstraction (master spec section 38).
 * Mirrors lib/telephony/types.ts's shape exactly, but for SENDING an SMS
 * rather than managing DIDs - and deliberately reuses the SAME per-org
 * encrypted credentials Phase 5 already stores in
 * phone_number_provider_credentials (Twilio Account SID/Auth Token,
 * Telnyx API key). There is NO separate SMS credential store - see
 * lib/sms/index.ts's header comment for exactly how those credentials
 * are looked up and decrypted.
 */

export type SmsProviderKey = 'twilio' | 'telnyx';

export interface SendSmsResult {
  providerMessageId: string;
  status: string;
}

export type SmsMessageProviderStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered' | 'unknown';

export class SmsProviderNotConfiguredError extends Error {
  constructor(message = 'This SMS provider is not connected for this organization.') {
    super(message);
    this.name = 'SmsProviderNotConfiguredError';
  }
}

export class SmsProviderError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'SmsProviderError';
  }
}

export interface SmsProviderAdapter {
  readonly key: SmsProviderKey;
  readonly isConfigured: boolean;
  /** Sends one SMS message via the real provider REST API. `from`/`to`
   * are strict E.164. Throws SmsProviderError on any non-2xx/network
   * failure - never fabricates a message id. */
  sendSms(from: string, to: string, body: string): Promise<SendSmsResult>;
  /** Fetches the real current delivery status of a previously-sent
   * message from the provider (used for reconciliation; the primary
   * status-update path is the provider's delivery-receipt webhook - see
   * routes/webhooks.ts). */
  getMessageStatus(providerMessageId: string): Promise<SmsMessageProviderStatus>;
}
