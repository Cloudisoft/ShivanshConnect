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

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';
const TWILIO_LOOKUP_BASE = 'https://lookups.twilio.com/v2';
const TWILIO_PRICING_BASE = 'https://pricing.twilio.com/v1';

interface TwilioAvailableNumber {
  phone_number: string;
  friendly_name: string | null;
  locality: string | null;
  region: string | null;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean; fax?: boolean };
}

/** Twilio's Pricing API returns per-country, per-number-type pricing (not
 * per individual number) - the closest real figure available for what a
 * local number in this country will cost per month. Never guessed: if the
 * lookup fails or the country isn't priced, callers get null, not a made-up
 * number. */
async function fetchLocalMonthlyPrice(
  country: string,
  authHeader: Record<string, string>,
): Promise<{ amount: number; currency: string } | null> {
  try {
    const res = await fetch(`${TWILIO_PRICING_BASE}/PhoneNumbers/Countries/${encodeURIComponent(country)}`, { headers: authHeader });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      price_unit?: string;
      phone_number_prices?: Array<{ number_type: string; current_price: string | null }>;
    };
    const local = json.phone_number_prices?.find((p) => p.number_type === 'local');
    if (!local?.current_price || !json.price_unit) return null;
    const amount = Number.parseFloat(local.current_price);
    if (!Number.isFinite(amount)) return null;
    return { amount, currency: json.price_unit };
  } catch {
    return null; // pricing is best-effort - never blocks the search itself
  }
}

interface TwilioIncomingPhoneNumber {
  sid: string;
  phone_number: string;
  friendly_name: string | null;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean; fax?: boolean };
}

function toCapabilities(caps: TwilioIncomingPhoneNumber['capabilities']): PhoneNumberCapabilities {
  // Twilio's IncomingPhoneNumbers API exposes a single `voice` capability
  // flag (not separate inbound/outbound) - a purchased number that can
  // carry voice at all can do both directions, so both map from it.
  return {
    voiceInbound: Boolean(caps?.voice),
    voiceOutbound: Boolean(caps?.voice),
    sms: Boolean(caps?.sms),
  };
}

function toNumberInfo(n: TwilioIncomingPhoneNumber): TelephonyNumberInfo {
  return {
    providerNumberId: n.sid,
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    capabilities: toCapabilities(n.capabilities),
  };
}

/**
 * Real Twilio REST API integration for DIDs/phone numbers, using an
 * Account SID + Auth Token (HTTP Basic Auth), per Twilio's actual
 * documented endpoints:
 *   GET /2010-04-01/Accounts/{AccountSid}.json                          - credential check
 *   GET /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json     - list
 *   GET /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers/{Sid}.json - get one
 *   GET https://lookups.twilio.com/v2/PhoneNumbers/{E164}                - validate
 *   GET /2010-04-01/Accounts/{AccountSid}/AvailablePhoneNumbers/{Country}/Local.json - search inventory
 *   POST /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json     - purchase
 * If no credentials are configured, every method throws
 * TelephonyProviderNotConfiguredError immediately - never fabricated
 * numbers.
 */
export class TwilioProvider implements TelephonyNumberProviderAdapter {
  readonly key = 'twilio' as const;
  readonly name = 'Twilio';
  readonly isManualOnly = false;
  private readonly accountSid: string | undefined;
  private readonly authToken: string | undefined;

  constructor(
    accountSid: string | undefined = process.env.TWILIO_ACCOUNT_SID,
    authToken: string | undefined = process.env.TWILIO_AUTH_TOKEN,
  ) {
    this.accountSid = accountSid && accountSid.trim().length > 0 ? accountSid.trim() : undefined;
    this.authToken = authToken && authToken.trim().length > 0 ? authToken.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.accountSid && this.authToken);
  }

  private requireCredentials(): { accountSid: string; authToken: string } {
    if (!this.accountSid || !this.authToken) {
      throw new TelephonyProviderNotConfiguredError(
        'Twilio is not connected for this organization. Add an Account SID and Auth Token under Phone Providers.',
      );
    }
    return { accountSid: this.accountSid, authToken: this.authToken };
  }

  private authHeader(accountSid: string, authToken: string): Record<string, string> {
    return { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` };
  }

  async connect(credentials: Record<string, string>): Promise<void> {
    const accountSid = credentials.account_sid;
    const authToken = credentials.auth_token;
    if (!accountSid || !authToken) {
      throw new TelephonyProviderNotConfiguredError('Both an Account SID and Auth Token are required to connect Twilio.');
    }
    let res: Response;
    try {
      res = await fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}.json`, {
        headers: this.authHeader(accountSid, authToken),
      });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Twilio API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Twilio credential check failed (${res.status}): ${body.slice(0, 500)}`);
    }
  }

  // No persistent server-side session exists to tear down for Twilio's
  // stateless REST API - this is a documented no-op. It NEVER releases
  // any real number from the Twilio account; releasing owned Twilio
  // numbers happens only through Twilio's own console/API, deliberately
  // out of scope here (see routes/phoneNumbers.ts's DELETE handler).
  async disconnect(): Promise<void> {
    return;
  }

  async listNumbers(): Promise<TelephonyNumberInfo[]> {
    const { accountSid, authToken } = this.requireCredentials();
    let res: Response;
    try {
      res = await fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json?PageSize=1000`, {
        headers: this.authHeader(accountSid, authToken),
      });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Twilio API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Twilio number list request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { incoming_phone_numbers: TwilioIncomingPhoneNumber[] };
    return (json.incoming_phone_numbers ?? []).map(toNumberInfo);
  }

  async importNumber(input: ImportNumberInput): Promise<TelephonyNumberInfo> {
    const { accountSid, authToken } = this.requireCredentials();
    if (!input.providerNumberId) {
      throw new TelephonyProviderError('A Twilio phone number SID is required to import a single number.');
    }
    let res: Response;
    try {
      res = await fetch(
        `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(input.providerNumberId)}.json`,
        { headers: this.authHeader(accountSid, authToken) },
      );
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Twilio API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Twilio get-number request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    return toNumberInfo((await res.json()) as TwilioIncomingPhoneNumber);
  }

  async validateNumber(e164: string): Promise<boolean> {
    const { accountSid, authToken } = this.requireCredentials();
    let res: Response;
    try {
      res = await fetch(`${TWILIO_LOOKUP_BASE}/PhoneNumbers/${encodeURIComponent(e164)}`, {
        headers: this.authHeader(accountSid, authToken),
      });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Twilio Lookup API.', err);
    }
    if (res.status === 404) return false;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Twilio Lookup request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { valid?: boolean };
    return json.valid !== false;
  }

  async getNumberStatus(providerNumberId: string): Promise<TelephonyNumberStatus> {
    const { accountSid, authToken } = this.requireCredentials();
    let res: Response;
    try {
      res = await fetch(
        `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(providerNumberId)}.json`,
        { headers: this.authHeader(accountSid, authToken) },
      );
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Twilio API.', err);
    }
    if (res.status === 404) return 'inactive';
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Twilio get-number-status request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    // Twilio's IncomingPhoneNumbers resource has no separate "status"
    // field - a 200 response for a still-owned SID means it is active.
    return 'active';
  }

  async searchAvailableNumbers(params: AvailableNumberSearchParams): Promise<AvailableNumber[]> {
    const { accountSid, authToken } = this.requireCredentials();
    const authHeader = this.authHeader(accountSid, authToken);
    const query = new URLSearchParams({ PageSize: String(Math.min(params.limit ?? 20, 50)) });
    if (params.areaCode) query.set('AreaCode', params.areaCode);
    if (params.contains) query.set('Contains', params.contains);

    let res: Response;
    try {
      res = await fetch(
        `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/AvailablePhoneNumbers/${encodeURIComponent(params.country)}/Local.json?${query.toString()}`,
        { headers: authHeader },
      );
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Twilio API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Twilio available-numbers search failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { available_phone_numbers: TwilioAvailableNumber[] };
    const price = await fetchLocalMonthlyPrice(params.country, authHeader);

    return (json.available_phone_numbers ?? []).map((n) => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name,
      locality: n.locality,
      region: n.region,
      capabilities: toCapabilities(n.capabilities),
      monthlyPrice: price?.amount ?? null,
      currency: price?.currency ?? null,
    }));
  }

  async purchaseNumber(e164: string): Promise<TelephonyNumberInfo> {
    const { accountSid, authToken } = this.requireCredentials();
    const form = new URLSearchParams({ PhoneNumber: e164 });
    let res: Response;
    try {
      res = await fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json`, {
        method: 'POST',
        headers: { ...this.authHeader(accountSid, authToken), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (err) {
      throw new TelephonyProviderError('Failed to reach the Twilio API.', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TelephonyProviderError(`Twilio number purchase failed (${res.status}): ${body.slice(0, 500)}`);
    }
    return toNumberInfo((await res.json()) as TwilioIncomingPhoneNumber);
  }
}
