import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmniVoiceProvider } from './omnivoice.js';
import { VoxCPMProvider } from './voxcpm.js';
import { VoiceProviderNotConfiguredError } from './types.js';

/** Unit tests for the two self-hosted (bring-your-own-endpoint)
 * adapters, covering the "not configured" honesty rule and the exact
 * request shape each makes once configured. Real inference is never run
 * here - fetch is mocked at the HTTP boundary, same as every other
 * adapter test. */

describe('OmniVoiceProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without both an endpoint URL and an API key', () => {
    expect(new OmniVoiceProvider(undefined, undefined).isConfigured).toBe(false);
    expect(new OmniVoiceProvider('https://example.com', undefined).isConfigured).toBe(false);
    expect(new OmniVoiceProvider(undefined, 'token').isConfigured).toBe(false);
    expect(new OmniVoiceProvider('https://example.com', 'token').isConfigured).toBe(true);
  });

  it('listVoices throws VoiceProviderNotConfiguredError when unconfigured, never fabricates a catalog', async () => {
    await expect(new OmniVoiceProvider(undefined, undefined).listVoices()).rejects.toBeInstanceOf(
      VoiceProviderNotConfiguredError,
    );
  });

  it('listVoices returns an empty list when configured - OmniVoice has no built-in catalog', async () => {
    const provider = new OmniVoiceProvider('https://api.replicate.com/v1/deployments/acme/omnivoice/predictions', 'token');
    await expect(provider.listVoices()).resolves.toEqual([]);
  });

  it('previewVoice posts a Replicate-shaped prediction request and polls to completion', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'pred-1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/pred-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'pred-1', status: 'succeeded', output: 'https://cdn.example.com/audio.wav' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'audio/wav' }),
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
      });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OmniVoiceProvider('https://api.replicate.com/v1/deployments/acme/omnivoice/predictions', 'token');
    const result = await provider.previewVoice('voice-1', 'Hi there');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.replicate.com/v1/deployments/acme/omnivoice/predictions');
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        body: JSON.stringify({ input: { task: 'synthesize', text: 'Hi there', voice_id: 'voice-1' } }),
      }),
    );
    expect(result.contentType).toBe('audio/wav');
  });
});

describe('VoxCPMProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without both an endpoint URL and an API key', () => {
    expect(new VoxCPMProvider(undefined, undefined).isConfigured).toBe(false);
    expect(new VoxCPMProvider('https://voxcpm.example.com', 'token').isConfigured).toBe(true);
  });

  it('listVoices throws VoiceProviderNotConfiguredError when unconfigured', async () => {
    await expect(new VoxCPMProvider(undefined, undefined).listVoices()).rejects.toBeInstanceOf(
      VoiceProviderNotConfiguredError,
    );
  });

  it('previewVoice calls the OpenAI-compatible /v1/audio/speech endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => new Uint8Array([3, 4]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VoxCPMProvider('https://voxcpm.example.com', 'token');
    await provider.previewVoice('preset-voice', 'Hello world');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://voxcpm.example.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        body: JSON.stringify({ model: 'openbmb/VoxCPM2', response_format: 'mp3', input: 'Hello world', voice: 'preset-voice' }),
      }),
    );
  });

  it('previewVoice passes ref_audio instead of voice for a cloned (URL-shaped) voice id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VoxCPMProvider('https://voxcpm.example.com', 'token');
    await provider.previewVoice('https://storage.example.com/samples/abc.wav', 'Hello world');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.ref_audio).toBe('https://storage.example.com/samples/abc.wav');
    expect(body.voice).toBeUndefined();
  });

  it('createVoice requires a reachable sample URL and verifies it with one real speech call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => new Uint8Array([]).buffer });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VoxCPMProvider('https://voxcpm.example.com', 'token');
    const result = await provider.createVoice({
      name: 'Clone',
      sampleAudio: Buffer.from('x'),
      sampleFileName: 'x.wav',
      sampleContentType: 'audio/wav',
      sampleAudioUrl: 'https://storage.example.com/samples/xyz.wav',
    });

    expect(result).toEqual({ providerVoiceId: 'https://storage.example.com/samples/xyz.wav', status: 'ready' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('createVoice throws without a sample URL rather than fabricating a clone', async () => {
    const provider = new VoxCPMProvider('https://voxcpm.example.com', 'token');
    await expect(
      provider.createVoice({ name: 'Clone', sampleAudio: Buffer.from('x'), sampleFileName: 'x.wav', sampleContentType: 'audio/wav' }),
    ).rejects.toThrow(/reachable URL/);
  });
});
