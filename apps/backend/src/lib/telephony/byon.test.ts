import { afterEach, describe, expect, it, vi } from 'vitest';
import { BYONProvider } from './byon.js';
import { TelephonyProviderError, TelephonyProviderNotSupportedError } from './types.js';

describe('BYONProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is always configured - there are no credentials to be missing', () => {
    expect(new BYONProvider().isConfigured).toBe(true);
  });

  it('connect/disconnect/listNumbers/getNumberStatus all throw TelephonyProviderNotSupportedError - there is no provider API', async () => {
    const provider = new BYONProvider();
    await expect(provider.connect()).rejects.toBeInstanceOf(TelephonyProviderNotSupportedError);
    await expect(provider.disconnect()).rejects.toBeInstanceOf(TelephonyProviderNotSupportedError);
    await expect(provider.listNumbers()).rejects.toBeInstanceOf(TelephonyProviderNotSupportedError);
    await expect(provider.getNumberStatus()).rejects.toBeInstanceOf(TelephonyProviderNotSupportedError);
    await expect(provider.searchAvailableNumbers()).rejects.toBeInstanceOf(TelephonyProviderNotSupportedError);
    await expect(provider.purchaseNumber()).rejects.toBeInstanceOf(TelephonyProviderNotSupportedError);
  });

  it('never makes a network call - manual declaration only', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new BYONProvider();
    await provider.importNumber({ e164: '+14845551234', capabilities: { voiceInbound: true, voiceOutbound: true, sms: false } });
    await provider.validateNumber('+14845551234');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('importNumber rejects an invalid E.164 number', async () => {
    const provider = new BYONProvider();
    await expect(
      provider.importNumber({ e164: 'not-a-phone-number', capabilities: { voiceInbound: true, voiceOutbound: true, sms: false } }),
    ).rejects.toBeInstanceOf(TelephonyProviderError);
  });

  it('importNumber rejects a number missing any declared capability', async () => {
    const provider = new BYONProvider();
    await expect(provider.importNumber({ e164: '+14845551234' })).rejects.toBeInstanceOf(TelephonyProviderError);
  });

  it('importNumber accepts a valid E.164 number and normalizes it, with no provider id', async () => {
    const provider = new BYONProvider();
    const result = await provider.importNumber({
      e164: '(484) 555-1234',
      friendlyName: 'Front desk',
      capabilities: { voiceInbound: true, voiceOutbound: false, sms: true },
    });
    expect(result).toEqual({
      providerNumberId: null,
      phoneNumber: '+14845551234',
      friendlyName: 'Front desk',
      capabilities: { voiceInbound: true, voiceOutbound: false, sms: true },
    });
  });

  it('validateNumber accepts a valid US number and rejects an invalid one', async () => {
    const provider = new BYONProvider();
    expect(await provider.validateNumber('+14845551234')).toBe(true);
    expect(await provider.validateNumber('12345')).toBe(false);
  });
});
