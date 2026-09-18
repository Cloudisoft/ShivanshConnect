import {
  type SendSmsResult,
  type SmsMessageProviderStatus,
  type SmsProviderAdapter,
  SmsProviderError,
  SmsProviderNotConfiguredError,
} from './types.js';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

interface TelnyxMessageResponse {
  data: { id: string; to?: Array<{ status?: string }> };
}

const STATUS_MAP: Record<string, SmsMessageProviderStatus> = {
  queued: 'queued',
  sending: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  delivery_failed: 'failed',
  delivery_unconfirmed: 'undelivered',
};

/**
 * Real Telnyx Messages API integration (spec 38), using the SAME API key
 * Phase 5's TelnyxProvider uses for DIDs - documented endpoint:
 *   POST /v2/messages
 *   GET  /v2/messages/{id}
 */
export class TelnyxSmsProvider implements SmsProviderAdapter {
  readonly key = 'telnyx' as const;
  private readonly apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new SmsProviderNotConfiguredError('Telnyx is not connected for this organization. Add an API key under Phone Providers.');
    }
    return this.apiKey;
  }

  async sendSms(from: string, to: string, body: string): Promise<SendSmsResult> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, text: body }),
      });
    } catch (err) {
      throw new SmsProviderError('Failed to reach the Telnyx API.', err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SmsProviderError(`Telnyx SMS send failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as TelnyxMessageResponse;
    const status = json.data.to?.[0]?.status ?? 'queued';
    return { providerMessageId: json.data.id, status: STATUS_MAP[status] ?? 'unknown' };
  }

  async getMessageStatus(providerMessageId: string): Promise<SmsMessageProviderStatus> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/messages/${encodeURIComponent(providerMessageId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      throw new SmsProviderError('Failed to reach the Telnyx API.', err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SmsProviderError(`Telnyx message-status request failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as TelnyxMessageResponse;
    const status = json.data.to?.[0]?.status ?? 'unknown';
    return STATUS_MAP[status] ?? 'unknown';
  }
}
