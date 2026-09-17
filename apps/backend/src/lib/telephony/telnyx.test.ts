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
});
