import {
  type SendSmsResult,
  type SmsMessageProviderStatus,
  type SmsProviderAdapter,
  SmsProviderError,
  SmsProviderNotConfiguredError,
} from './types.js';

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

interface TwilioMessageResponse {
  sid: string;
  status: string;
}

const STATUS_MAP: Record<string, SmsMessageProviderStatus> = {
  queued: 'queued',
  accepted: 'queued',
  sending: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
};

/**
 * Real Twilio Messages API integration (spec 38), using the SAME
 * Account SID + Auth Token credentials Phase 5's TwilioProvider uses for
 * DIDs - documented endpoint:
 *   POST /2010-04-01/Accounts/{AccountSid}/Messages.json
 *   GET  /2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}.json
 */
export class TwilioSmsProvider implements SmsProviderAdapter {
  readonly key = 'twilio' as const;
  private readonly accountSid?: string;
  private readonly authToken?: string;

  constructor(accountSid?: string, authToken?: string) {
    this.accountSid = accountSid?.trim() || undefined;
    this.authToken = authToken?.trim() || undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.accountSid && this.authToken);
  }

  private requireCredentials(): { accountSid: string; authToken: string } {
    if (!this.accountSid || !this.authToken) {
      throw new SmsProviderNotConfiguredError('Twilio is not connected for this organization. Add credentials under Phone Providers.');
    }
    return { accountSid: this.accountSid, authToken: this.authToken };
  }

  private authHeader(accountSid: string, authToken: string): Record<string, string> {
    return { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` };
  }

  async sendSms(from: string, to: string, body: string): Promise<SendSmsResult> {
    const { accountSid, authToken } = this.requireCredentials();
    const form = new URLSearchParams({ From: from, To: to, Body: body });
    let res: Response;
    try {
      res = await fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: 'POST',
        headers: { ...this.authHeader(accountSid, authToken), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (err) {
      throw new SmsProviderError('Failed to reach the Twilio API.', err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SmsProviderError(`Twilio SMS send failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as TwilioMessageResponse;
    return { providerMessageId: json.sid, status: STATUS_MAP[json.status] ?? 'unknown' };
  }

  async getMessageStatus(providerMessageId: string): Promise<SmsMessageProviderStatus> {
    const { accountSid, authToken } = this.requireCredentials();
    let res: Response;
    try {
      res = await fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages/${encodeURIComponent(providerMessageId)}.json`, {
        headers: this.authHeader(accountSid, authToken),
      });
    } catch (err) {
      throw new SmsProviderError('Failed to reach the Twilio API.', err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SmsProviderError(`Twilio message-status request failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as TwilioMessageResponse;
    return STATUS_MAP[json.status] ?? 'unknown';
  }
}
