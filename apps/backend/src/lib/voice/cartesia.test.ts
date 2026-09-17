import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartesiaProvider } from './cartesia.js';
import { VoiceProviderNotConfiguredError } from './types.js';

describe('CartesiaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without an API key', () => {
    expect(new CartesiaProvider(undefined).isConfigured).toBe(false);
  });

  it('listVoices throws VoiceProviderNotConfiguredError, never fabricates voices', async () => {
    await expect(new CartesiaProvider(undefined).listVoices()).rejects.toBeInstanceOf(VoiceProviderNotConfiguredError);
  });

  it('listVoices calls GET /voices with X-API-Key and Cartesia-Version headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'v1', name: 'Nova', language: 'en', gender: 'female' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CartesiaProvider('sk_car_123');
    const voices = await provider.listVoices();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cartesia.ai/voices',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'sk_car_123', 'Cartesia-Version': '2024-06-10' }),
      }),
    );
    expect(voices).toEqual([
      { providerVoiceId: 'v1', name: 'Nova', gender: 'female', language: 'en', description: undefined, requiresExternalHosting: false },
    ]);
  });

  it('previewVoice posts to /tts/bytes with the documented voice-by-id shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CartesiaProvider('sk_car_123');
    await provider.previewVoice('v1', 'Hello');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cartesia.ai/tts/bytes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model_id: 'sonic-2',
          transcript: 'Hello',
          voice: { mode: 'id', id: 'v1' },
          output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
        }),
      }),
    );
  });

  it('createVoice posts multipart form data to /voices/clone', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'cloned-1' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CartesiaProvider('sk_car_123');
    const result = await provider.createVoice({
      name: 'My Clone',
      sampleAudio: Buffer.from('fake-audio'),
      sampleFileName: 'sample.wav',
      sampleContentType: 'audio/wav',
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.cartesia.ai/voices/clone', expect.objectContaining({ method: 'POST' }));
    expect(result).toEqual({ providerVoiceId: 'cloned-1', status: 'ready' });
  });
});
