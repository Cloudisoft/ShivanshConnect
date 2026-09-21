import {
  type AvailableNumber,
  type AvailableNumberSearchParams,
  type ImportNumberInput,
  type PhoneNumberCapabilities,
  type TelephonyNumberInfo,
  type TelephonyNumberProviderAdapter,
  type TelephonyNumberStatus,
  TelephonyProviderError,
  TelephonyProviderNotConfiguredError,
} from './types.js';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

interface TelnyxAvailableNumber {
  phone_number: string;
  region_information?: Array<{ region_name?: string; region_type?: string }>;
  features?: Array<{ name: string } | string>;
  cost_information?: { upfront_cost?: string; monthly_cost?: string; currency?: string } | null;
}

interface TelnyxPhoneNumber {
  id: string;
  phone_number: string;
  connection_name?: string | null;
  status?: string;
  features?: Array<{ name: string } | string>;
}

function featureNames(features: TelnyxPhoneNumber['features']): string[] {
  return (features ?? []).map((f) => (typeof f === 'string' ? f : f.name));
}

function toCapabilities(features: TelnyxPhoneNumber['features']): PhoneNumberCapabilities {
  const names = featureNames(features);
  const hasVoice = names.includes('voice');
  return {
    voiceInbound: hasVoice,
    voiceOutbound: hasVoice,
    sms: names.includes('sms'),
  };
}

function toNumberInfo(n: TelnyxPhoneNumber): TelephonyNumberInfo {
  return {
    providerNumberId: n.id,
    phoneNumber: n.phone_number,
    friendlyName: n.connection_name ?? null,
    capabilities: toCapabilities(n.features),
  };
}

/**
 * Real Telnyx REST API integration for DIDs/phone numbers, using an API
 * key (Bearer token), per Telnyx's actual documented endpoints:
 *   GET /v2/phone_numbers?page[size]=1        - credential check (cheapest real authenticated read)
 *   GET /v2/phone_numbers                     - list (paginated, `data` array)
 *   GET /v2/phone_numbers/{id}                - get one
 *   GET /v2/number_lookup/{E164}              - validate
 *   GET /v2/available_phone_numbers           - search purchasable inventory (real pricing included)
 *   POST /v2/number_orders                    - purchase
 * If no API key is configured, every method throws
 * TelephonyProviderNotConfiguredError immediately - never fabricated
 * numbers.
 */
export class TelnyxProvider implements TelephonyNumberProviderAdapter {
  readonly key = 'telnyx' as const;
  readonly name = 'Telnyx';
  readonly isManualOnly = false;
  private readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined = process.env.TELNYX_API_KEY) {
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new TelephonyProviderNotConfiguredError(
        'Telnyx is not connected for this organization. Add an API key under Phone Providers.',
      );
    }
    return this.apiKey;
  }

  private headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  }

  async connect(credentials: Record<string, string>): Promise<void> {
    const apiKey = credentials.api_key;
    if (!apiKey) {
      throw new TelephonyProviderNotConfiguredError('An API key is required to connect Telnyx.');
    }
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/phone_numbers?page[size]=1`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Telnyx API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Telnyx credential check failed (${res.status}): ${body.slice(0, 500)}`);
    }
  }

  // No persistent server-side session exists to tear down for Telnyx's
  // stateless REST API - this is a documented no-op. It NEVER releases
  // any real number from the Telnyx account.
  async disconnect(): Promise<void> {
    return;
  }

  async listNumbers(): Promise<TelephonyNumberInfo[]> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/phone_numbers?page[size]=250`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Telnyx API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Telnyx number list request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data: TelnyxPhoneNumber[] };
    return (json.data ?? []).map(toNumberInfo);
  }

  async importNumber(input: ImportNumberInput): Promise<TelephonyNumberInfo> {
    const apiKey = this.requireKey();
    if (!input.providerNumberId) {
      throw new TelephonyProviderError('A Telnyx phone number id is required to import a single number.');
    }
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/phone_numbers/${encodeURIComponent(input.providerNumberId)}`, {
        headers: this.headers(apiKey),
      });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Telnyx API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Telnyx get-number request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data: TelnyxPhoneNumber };
    return toNumberInfo(json.data);
  }

  async validateNumber(e164: string): Promise<boolean> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/number_lookup/${encodeURIComponent(e164)}`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Telnyx Number Lookup API.', err);
    }
    if (res.status === 404) return false;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Telnyx Number Lookup request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data?: { phone_number?: string } };
    return Boolean(json.data?.phone_number);
  }

  async getNumberStatus(providerNumberId: string): Promise<TelephonyNumberStatus> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/phone_numbers/${encodeURIComponent(providerNumberId)}`, {
        headers: this.headers(apiKey),
      });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Telnyx API.', err);
    }
    if (res.status === 404) return 'inactive';
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Telnyx get-number-status request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data: TelnyxPhoneNumber };
    return json.data.status === 'active' ? 'active' : 'inactive';
  }

  async searchAvailableNumbers(params: AvailableNumberSearchParams): Promise<AvailableNumber[]> {
    const apiKey = this.requireKey();
    const query = new URLSearchParams({
      'filter[country_code]': params.country,
      'filter[limit]': String(Math.min(params.limit ?? 20, 50)),
      'filter[features]': 'voice',
    });
    if (params.areaCode) query.set('filter[national_destination_code]', params.areaCode);
    if (params.contains) query.set('filter[phone_number][contains]', params.contains);

    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/available_phone_numbers?${query.toString()}`, { headers: this.headers(apiKey) });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Telnyx API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Telnyx available-numbers search failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data: TelnyxAvailableNumber[] };
    return (json.data ?? []).map((n) => {
      const names = featureNames(n.features);
      const hasVoice = names.includes('voice');
      const monthlyCost = n.cost_information?.monthly_cost;
      const region = n.region_information?.find((r) => r.region_type === 'state')?.region_name ?? null;
      const locality = n.region_information?.find((r) => r.region_type === 'rate_center' || r.region_type === 'city')?.region_name ?? null;
      return {
        phoneNumber: n.phone_number,
        friendlyName: null,
        locality,
        region,
        capabilities: { voiceInbound: hasVoice, voiceOutbound: hasVoice, sms: names.includes('sms') },
        monthlyPrice: monthlyCost ? Number.parseFloat(monthlyCost) : null,
        currency: n.cost_information?.currency ?? null,
      };
    });
  }

  async purchaseNumber(e164: string): Promise<TelephonyNumberInfo> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${TELNYX_API_BASE}/number_orders`, {
        method: 'POST',
        headers: { ...this.headers(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_numbers: [{ phone_number: e164 }] }),
      });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Telnyx API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Telnyx number purchase failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      data: { phone_numbers: Array<{ id: string; phone_number: string; status?: string }> };
    };
    const purchased = json.data.phone_numbers[0];
    if (!purchased) {
      throw new TelephonyProviderError('Telnyx accepted the number order but returned no phone number in its response.');
    }
    return {
      providerNumberId: purchased.id,
      phoneNumber: purchased.phone_number,
      friendlyName: null,
      capabilities: { voiceInbound: true, voiceOutbound: true, sms: false },
    };
  }
}
