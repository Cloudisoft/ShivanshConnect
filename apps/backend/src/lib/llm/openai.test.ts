import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from './openai.js';
import { LlmNotConfiguredError } from './types.js';

describe('OpenAIProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not configured when no API key is provided', () => {
    const provider = new OpenAIProvider(undefined);
    expect(provider.isConfigured).toBe(false);
  });

  it('is configured when an API key is provided', () => {
    const provider = new OpenAIProvider('sk-test-123');
    expect(provider.isConfigured).toBe(true);
  });

  it('generateText throws LlmNotConfiguredError with no API key, never fabricates a response', async () => {
    const provider = new OpenAIProvider(undefined);
    await expect(provider.generateText({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    );
  });

  it('embedText throws LlmNotConfiguredError with no API key, never fabricates vectors', async () => {
    const provider = new OpenAIProvider(undefined);
    await expect(provider.embedText(['hello world'])).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it('embedText returns an empty result for an empty input list even when configured', async () => {
    const provider = new OpenAIProvider('sk-test-123');
    const result = await provider.embedText([]);
    expect(result.embeddings).toEqual([]);
  });

  it('generateText calls the OpenAI chat completions endpoint and returns its text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'Hello there!' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('sk-test-123');
    const result = await provider.generateText({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.text).toBe('Hello there!');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('generateText throws LlmProviderError on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('sk-bad-key');
    await expect(
      provider.generateText({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/OpenAI chat completion failed/);
  });
});
