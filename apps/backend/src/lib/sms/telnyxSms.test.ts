import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelnyxSmsProvider } from './telnyxSms.js';
import { SmsProviderError, SmsProviderNotConfiguredError } from './types.js';

describe('TelnyxSmsProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without an API key', () => {
    expect(new TelnyxSmsProvider(undefined).isConfigured).toBe(false);
  });

  it('sendSms throws SmsProviderNotConfiguredError without an API key', async () => {
    const provider = new TelnyxSmsProvider(undefined);
    await expect(provider.sendSms('+15551110000', '+15551112222', 'hi')).rejects.toBeInstanceOf(SmsProviderNotConfiguredError);
  });

  it('sendSms posts to the real Telnyx Messages API endpoint with a Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'msg-1', to: [{ status: 'queued' }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TelnyxSmsProvider('KEY123');
    const result = await provider.sendSms('+15551110000', '+15551112222', 'Hello there');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telnyx.com/v2/messages',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer KEY123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '+15551110000', to: '+15551112222', text: 'Hello there' }),
      }),
    );
    expect(result).toEqual({ providerMessageId: 'msg-1', status: 'queued' });
  });

  it('sendSms throws SmsProviderError on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid destination' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TelnyxSmsProvider('KEY123');
    await expect(provider.sendSms('+15551110000', 'bad', 'hi')).rejects.toBeInstanceOf(SmsProviderError);
  });

  it('getMessageStatus maps the real per-recipient status field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'msg-1', to: [{ status: 'delivered' }] } }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TelnyxSmsProvider('KEY123');
    expect(await provider.getMessageStatus('msg-1')).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledWith('https://api.telnyx.com/v2/messages/msg-1', expect.any(Object));
  });
});
