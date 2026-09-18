import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwilioSmsProvider } from './twilioSms.js';
import { SmsProviderError, SmsProviderNotConfiguredError } from './types.js';

describe('TwilioSmsProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without credentials', () => {
    expect(new TwilioSmsProvider(undefined, undefined).isConfigured).toBe(false);
  });

  it('sendSms throws SmsProviderNotConfiguredError without credentials', async () => {
    const provider = new TwilioSmsProvider(undefined, undefined);
    await expect(provider.sendSms('+15551110000', '+15551112222', 'hi')).rejects.toBeInstanceOf(SmsProviderNotConfiguredError);
  });

  it('sendSms posts to the real Twilio Messages API endpoint with Basic auth and form-encoded body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sid: 'SM123', status: 'queued' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TwilioSmsProvider('AC123', 'TOKEN');
    const result = await provider.sendSms('+15551110000', '+15551112222', 'Hello there');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('AC123:TOKEN').toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
        body: 'From=%2B15551110000&To=%2B15551112222&Body=Hello+there',
      }),
    );
    expect(result).toEqual({ providerMessageId: 'SM123', status: 'queued' });
  });

  it('sendSms throws SmsProviderError on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Invalid To number' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TwilioSmsProvider('AC123', 'TOKEN');
    await expect(provider.sendSms('+15551110000', 'bad', 'hi')).rejects.toBeInstanceOf(SmsProviderError);
  });

  it('getMessageStatus maps the real status field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sid: 'SM123', status: 'delivered' }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TwilioSmsProvider('AC123', 'TOKEN');
    expect(await provider.getMessageStatus('SM123')).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledWith('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123.json', expect.any(Object));
  });
});
