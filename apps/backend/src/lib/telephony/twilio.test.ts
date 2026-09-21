import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwilioProvider } from './twilio.js';
import { TelephonyProviderError, TelephonyProviderNotConfiguredError } from './types.js';

describe('TwilioProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without an Account SID + Auth Token', () => {
    expect(new TwilioProvider(undefined, undefined).isConfigured).toBe(false);
    expect(new TwilioProvider('AC123', undefined).isConfigured).toBe(false);
  });

  it('listNumbers throws TelephonyProviderNotConfiguredError, never fabricates numbers', async () => {
    const provider = new TwilioProvider(undefined, undefined);
    await expect(provider.listNumbers()).rejects.toBeInstanceOf(TelephonyProviderNotConfiguredError);
  });

  it('connect() calls GET /Accounts/{sid}.json with Basic Auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioProvider();
    await provider.connect({ account_sid: 'AC123', auth_token: 'secret-token' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123.json',
      expect.objectContaining({
        headers: { Authorization: `Basic ${Buffer.from('AC123:secret-token').toString('base64')}` },
      }),
    );
  });

  it('connect() throws TelephonyProviderError on a rejected credential check', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Authenticate' });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioProvider();
    await expect(provider.connect({ account_sid: 'AC123', auth_token: 'bad' })).rejects.toBeInstanceOf(TelephonyProviderError);
  });

  it('listNumbers calls the real IncomingPhoneNumbers endpoint and maps capabilities', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        incoming_phone_numbers: [
          { sid: 'PN123', phone_number: '+14845551234', friendly_name: 'Main line', capabilities: { voice: true, sms: true, mms: false, fax: false } },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioProvider('AC123', 'secret-token');
    const numbers = await provider.listNumbers();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PageSize=1000',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(numbers).toEqual([
      {
        providerNumberId: 'PN123',
        phoneNumber: '+14845551234',
        friendlyName: 'Main line',
        capabilities: { voiceInbound: true, voiceOutbound: true, sms: true },
      },
    ]);
  });

  it('validateNumber calls the real Lookup v2 endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ valid: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioProvider('AC123', 'secret-token');
    const valid = await provider.validateNumber('+14845551234');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://lookups.twilio.com/v2/PhoneNumbers/%2B14845551234',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(valid).toBe(true);
  });

  it('validateNumber returns false on a 404 (not a real number)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TwilioProvider('AC123', 'secret-token');
    expect(await provider.validateNumber('+10000000000')).toBe(false);
  });

  it('disconnect() is a documented no-op - never calls the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TwilioProvider('AC123', 'secret-token');
    await provider.disconnect();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('searchAvailableNumbers() searches AvailablePhoneNumbers and attaches real pricing', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/AvailablePhoneNumbers/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            available_phone_numbers: [
              {
                phone_number: '+14845551234',
                friendly_name: '(484) 555-1234',
                locality: 'Reading',
                region: 'PA',
                capabilities: { voice: true, sms: true },
              },
            ],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ price_unit: 'USD', phone_number_prices: [{ number_type: 'local', current_price: '1.15' }] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioProvider('AC123', 'secret-token');
    const results = await provider.searchAvailableNumbers({ country: 'US', areaCode: '484' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/Accounts/AC123/AvailablePhoneNumbers/US/Local.json?PageSize=20&AreaCode=484'),
      expect.any(Object),
    );
    expect(results).toEqual([
      {
        phoneNumber: '+14845551234',
        friendlyName: '(484) 555-1234',
        locality: 'Reading',
        region: 'PA',
        capabilities: { voiceInbound: true, voiceOutbound: true, sms: true },
        monthlyPrice: 1.15,
        currency: 'USD',
      },
    ]);
  });

  it('searchAvailableNumbers() still returns results with null pricing if the Pricing API fails', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/AvailablePhoneNumbers/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            available_phone_numbers: [
              { phone_number: '+14845551234', friendly_name: null, locality: null, region: null, capabilities: { voice: true } },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioProvider('AC123', 'secret-token');
    const results = await provider.searchAvailableNumbers({ country: 'US' });
    expect(results[0].monthlyPrice).toBeNull();
    expect(results[0].currency).toBeNull();
  });

  it('purchaseNumber() POSTs PhoneNumber as form-urlencoded and returns the purchased number', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sid: 'PN123',
        phone_number: '+14845551234',
        friendly_name: '(484) 555-1234',
        capabilities: { voice: true, sms: false },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioProvider('AC123', 'secret-token');
    const purchased = await provider.purchaseNumber('+14845551234');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json',
      expect.objectContaining({ method: 'POST', body: 'PhoneNumber=%2B14845551234' }),
    );
    expect(purchased).toEqual({
      providerNumberId: 'PN123',
      phoneNumber: '+14845551234',
      friendlyName: '(484) 555-1234',
      capabilities: { voiceInbound: true, voiceOutbound: true, sms: false },
    });
  });

  it('purchaseNumber() throws TelephonyProviderError on a rejected purchase', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Number unavailable' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TwilioProvider('AC123', 'secret-token');
    await expect(provider.purchaseNumber('+14845551234')).rejects.toBeInstanceOf(TelephonyProviderError);
  });
});
