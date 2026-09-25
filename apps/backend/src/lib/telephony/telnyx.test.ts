import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelnyxProvider } from './telnyx.js';
import { TelephonyProviderError, TelephonyProviderNotConfiguredError } from './types.js';

describe('TelnyxProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without an API key', () => {
    expect(new TelnyxProvider(undefined).isConfigured).toBe(false);
  });

  it('listNumbers throws TelephonyProviderNotConfiguredError, never fabricates numbers', async () => {
    const provider = new TelnyxProvider(undefined);
    await expect(provider.listNumbers()).rejects.toBeInstanceOf(TelephonyProviderNotConfiguredError);
  });

  it('connect() calls GET /v2/phone_numbers with a Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TelnyxProvider();
    await provider.connect({ api_key: 'KEY123' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telnyx.com/v2/phone_numbers?page[size]=1',
      expect.objectContaining({ headers: { Authorization: 'Bearer KEY123' } }),
    );
  });

  it('connect() throws TelephonyProviderError on a rejected credential check', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TelnyxProvider();
    await expect(provider.connect({ api_key: 'bad' })).rejects.toBeInstanceOf(TelephonyProviderError);
  });

  it('listNumbers calls the real /v2/phone_numbers endpoint and maps features to capabilities', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'tlx-1', phone_number: '+14845559876', connection_name: 'My connection', status: 'active', features: ['voice', 'sms'] },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TelnyxProvider('KEY123');
    const numbers = await provider.listNumbers();

    expect(fetchMock).toHaveBeenCalledWith('https://api.telnyx.com/v2/phone_numbers?page[size]=250', expect.any(Object));
    expect(numbers).toEqual([
      {
        providerNumberId: 'tlx-1',
        phoneNumber: '+14845559876',
        friendlyName: 'My connection',
        capabilities: { voiceInbound: true, voiceOutbound: true, sms: true },
      },
    ]);
  });

  it('getNumberStatus maps the real status field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'tlx-1', phone_number: '+1', status: 'port_pending' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TelnyxProvider('KEY123');
    expect(await provider.getNumberStatus('tlx-1')).toBe('inactive');
  });

  it('validateNumber calls the real /v2/number_lookup endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { phone_number: '+14845551234' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TelnyxProvider('KEY123');
    const valid = await provider.validateNumber('+14845551234');
    expect(fetchMock).toHaveBeenCalledWith('https://api.telnyx.com/v2/number_lookup/%2B14845551234', expect.any(Object));
    expect(valid).toBe(true);
  });

  it('searchAvailableNumbers() calls /v2/available_phone_numbers and maps real cost_information', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            phone_number: '+14845551234',
            region_information: [
              { region_type: 'state', region_name: 'PA' },
              { region_type: 'rate_center', region_name: 'Reading' },
            ],
            features: ['voice', 'sms'],
            cost_information: { monthly_cost: '1.00', currency: 'USD' },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TelnyxProvider('KEY123');
    const results = await provider.searchAvailableNumbers({ country: 'US', areaCode: '484' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('filter%5Bnational_destination_code%5D=484'),
      expect.any(Object),
    );
    expect(results).toEqual([
      {
        phoneNumber: '+14845551234',
        friendlyName: null,
        locality: 'Reading',
        region: 'PA',
        capabilities: { voiceInbound: true, voiceOutbound: true, sms: true },
        monthlyPrice: 1.0,
        currency: 'USD',
      },
    ]);
  });

  it('purchaseNumber() POSTs to /v2/number_orders and returns the purchased number', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { phone_numbers: [{ id: 'tlx-new', phone_number: '+14845551234' }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TelnyxProvider('KEY123');
    const purchased = await provider.purchaseNumber('+14845551234');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telnyx.com/v2/number_orders',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ phone_numbers: [{ phone_number: '+14845551234' }] }),
      }),
    );
    expect(purchased).toEqual({
      providerNumberId: 'tlx-new',
      phoneNumber: '+14845551234',
      friendlyName: null,
      capabilities: { voiceInbound: true, voiceOutbound: true, sms: false },
    });
  });

  it('purchaseNumber() throws TelephonyProviderError on a rejected order', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'Number unavailable' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TelnyxProvider('KEY123');
    await expect(provider.purchaseNumber('+14845551234')).rejects.toBeInstanceOf(TelephonyProviderError);
  });

  it('getBalance() calls GET /v2/balance and parses the real balance/currency', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { balance: '17.35', currency: 'USD' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TelnyxProvider('KEY123');
    const balance = await provider.getBalance();
    expect(fetchMock).toHaveBeenCalledWith('https://api.telnyx.com/v2/balance', { headers: { Authorization: 'Bearer KEY123' } });
    expect(balance).toEqual({ amount: 17.35, currency: 'USD' });
  });

  it('getBalance() throws TelephonyProviderNotConfiguredError without an API key, never fabricates a balance', async () => {
    const provider = new TelnyxProvider(undefined);
    await expect(provider.getBalance()).rejects.toBeInstanceOf(TelephonyProviderNotConfiguredError);
  });

  it('getBalance() throws TelephonyProviderError on a rejected request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TelnyxProvider('KEY123');
    await expect(provider.getBalance()).rejects.toBeInstanceOf(TelephonyProviderError);
  });
});
