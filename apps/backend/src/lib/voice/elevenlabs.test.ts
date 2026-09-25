import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsProvider } from './elevenlabs.js';
import { VoiceProviderNotConfiguredError } from './types.js';

describe('ElevenLabsProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without an API key', () => {
    expect(new ElevenLabsProvider(undefined).isConfigured).toBe(false);
  });

  it('listVoices throws VoiceProviderNotConfiguredError, never fabricates voices', async () => {
    const provider = new ElevenLabsProvider(undefined);
    await expect(provider.listVoices()).rejects.toBeInstanceOf(VoiceProviderNotConfiguredError);
  });

  it('listVoices calls GET /v1/voices with the xi-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ voices: [{ voice_id: 'v1', name: 'Rachel', labels: { gender: 'female', accent: 'american' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsProvider('key-123');
    const voices = await provider.listVoices();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/voices',
      expect.objectContaining({ headers: expect.objectContaining({ 'xi-api-key': 'key-123' }) }),
    );
    expect(voices).toEqual([
      { providerVoiceId: 'v1', name: 'Rachel', gender: 'female', language: undefined, accent: 'american', description: undefined, requiresExternalHosting: false },
    ]);
  });

  it('previewVoice posts to the text-to-speech endpoint and returns raw audio bytes', async () => {
    const audioBytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => audioBytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsProvider('key-123');
    const result = await provider.previewVoice('v1', 'Hello there');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/text-to-speech/v1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'xi-api-key': 'key-123', Accept: 'audio/mpeg' }),
        body: JSON.stringify({ text: 'Hello there', model_id: 'eleven_multilingual_v2' }),
      }),
    );
    expect(result.contentType).toBe('audio/mpeg');
    expect(Buffer.from(result.audio)).toEqual(Buffer.from(audioBytes));
  });

  it('createVoice posts multipart form data to /v1/voices/add', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ voice_id: 'cloned-1' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsProvider('key-123');
    const result = await provider.createVoice({
      name: 'My Clone',
      sampleAudio: Buffer.from('fake-audio'),
      sampleFileName: 'sample.wav',
      sampleContentType: 'audio/wav',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/voices/add',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = fetchMock.mock.calls[0][1] as RequestInit;
    expect(call.body).toBeInstanceOf(FormData);
    expect(result).toEqual({ providerVoiceId: 'cloned-1', status: 'ready' });
  });

  it('surfaces a VoiceProviderError with the response body on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid api key' });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsProvider('bad-key');
    await expect(provider.listVoices()).rejects.toThrow(/ElevenLabs voice list request failed/);
  });

  it('getUsage() calls GET /v1/user/subscription and returns real character quota usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ character_count: 12345, character_limit: 100000 }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsProvider('key-123');
    const usage = await provider.getUsage!();

    expect(fetchMock).toHaveBeenCalledWith('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': 'key-123' } });
    expect(usage).toEqual({ charactersUsed: 12345, characterLimit: 100000 });
  });

  it('getUsage() throws VoiceProviderNotConfiguredError without an API key, never fabricates usage', async () => {
    const provider = new ElevenLabsProvider(undefined);
    await expect(provider.getUsage!()).rejects.toBeInstanceOf(VoiceProviderNotConfiguredError);
  });
});
