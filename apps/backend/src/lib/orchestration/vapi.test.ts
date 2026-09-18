import { afterEach, describe, expect, it, vi } from 'vitest';
import { VapiProvider } from './vapi.js';
import { OrchestrationProviderError, OrchestrationProviderNotConfiguredError, type AssistantConfig } from './types.js';

const BASE_CONFIG: AssistantConfig = {
  agentId: 'agent-1',
  agentVersionId: 'version-1',
  organizationId: 'org-1',
  name: 'Sales Assistant',
  systemPrompt: 'You are a helpful sales agent.',
  greeting: 'Hi there!',
  personality: { tone: 'Friendly', personality_traits: ['Persuasive'], behavior_traits: ['Confirms next steps'] },
  llmProvider: 'openai',
  llmModel: 'gpt-4o-mini',
  llmTemperature: 0.7,
  llmMaxTokens: 800,
  voice: { providerKey: 'elevenlabs', providerVoiceId: 'voice-123' },
  transferRules: { on_no_match: 'transfer', transfer_to: '+14845550000', conditions: [] },
  maxCallDurationSeconds: 600,
};

describe('VapiProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without an API key', () => {
    expect(new VapiProvider(undefined).isConfigured).toBe(false);
  });

  it('every method throws OrchestrationProviderNotConfiguredError when unset - never fabricates', async () => {
    const provider = new VapiProvider(undefined);
    await expect(provider.createAssistant(BASE_CONFIG)).rejects.toBeInstanceOf(OrchestrationProviderNotConfiguredError);
    await expect(provider.getCall('call-1')).rejects.toBeInstanceOf(OrchestrationProviderNotConfiguredError);
    await expect(provider.registerWebhook('https://example.com/webhook')).rejects.toBeInstanceOf(OrchestrationProviderNotConfiguredError);
  });

  it('createAssistant() POSTs /assistant with the mapped payload shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'asst_123' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VapiProvider('sk-test');
    const result = await provider.createAssistant(BASE_CONFIG);

    expect(result.providerAssistantId).toBe('asst_123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.vapi.ai/assistant');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.name).toBe('Sales Assistant');
    expect(body.firstMessage).toBe('Hi there!');
    expect(body.model).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 800,
      messages: [{ role: 'system', content: expect.stringContaining('You are a helpful sales agent.') }],
    });
    expect(body.voice).toEqual({ provider: 'elevenlabs', voiceId: 'voice-123' });
    expect(body.maxDurationSeconds).toBe(600);
    expect(body.forwardingPhoneNumber).toBe('+14845550000');
    // Conversational-quality config (Bug 2): real, currently-documented
    // Vapi fields for natural turn-taking and a sane silence timeout,
    // always set.
    expect(body.startSpeakingPlan).toEqual({ waitSeconds: 0.4, smartEndpointingPlan: { provider: 'vapi' } });
    expect(body.silenceTimeoutSeconds).toBe(30);
    // No voicemailDetection/backgroundDenoisingEnabled without config.
    expect(body.voicemailDetection).toBeUndefined();
    expect(body.backgroundDenoisingEnabled).toBeUndefined();
  });

  it('createAssistant() forwards voicemail detection and background denoising when configured (Bug 2)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'asst_123' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VapiProvider('sk-test');
    await provider.createAssistant({
      ...BASE_CONFIG,
      voicemailDetection: { enabled: true, leaveVoicemail: true, message: 'Please call us back at 555-0100.' },
      backgroundNoise: 'medium',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voicemailDetection).toEqual({ provider: 'vapi' });
    expect(body.voicemailMessage).toBe('Please call us back at 555-0100.');
    expect(body.backgroundDenoisingEnabled).toBe(true);
  });

  it('createAssistant() omits voicemailMessage when leaveVoicemail is false, but still enables detection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'asst_123' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VapiProvider('sk-test');
    await provider.createAssistant({
      ...BASE_CONFIG,
      voicemailDetection: { enabled: true, leaveVoicemail: false, message: 'Never sent.' },
      backgroundNoise: 'off',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voicemailDetection).toEqual({ provider: 'vapi' });
    expect(body.voicemailMessage).toBeUndefined();
    expect(body.backgroundDenoisingEnabled).toBe(false);
  });

  it('createCall() requires an assistant id and an imported phone number id', async () => {
    const provider = new VapiProvider('sk-test');
    await expect(
      provider.createCall({
        callId: 'call-1',
        organizationId: 'org-1',
        providerAssistantId: null,
        agentVersionId: 'version-1',
        fromPhoneNumber: '+14845551111',
        fromPhoneNumberProviderId: null,
        toPhoneNumber: '+14845552222',
        transferDestinationE164: null,
      }),
    ).rejects.toBeInstanceOf(OrchestrationProviderError);
  });

  it('createCall() POSTs /call with assistantId/phoneNumberId/customer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'call_abc', status: 'queued' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VapiProvider('sk-test');
    const result = await provider.createCall({
      callId: 'internal-call-1',
      organizationId: 'org-1',
      providerAssistantId: 'asst_123',
      agentVersionId: 'version-1',
      fromPhoneNumber: '+14845551111',
      fromPhoneNumberProviderId: 'vapi-pn-1',
      toPhoneNumber: '+14845552222',
      transferDestinationE164: null,
    });

    expect(result).toEqual({ providerCallId: 'call_abc', status: 'queued' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.vapi.ai/call');
    const body = JSON.parse(init.body);
    expect(body.assistantId).toBe('asst_123');
    expect(body.phoneNumberId).toBe('vapi-pn-1');
    expect(body.customer).toEqual({ number: '+14845552222' });
    expect(body.metadata).toEqual({ internalCallId: 'internal-call-1', organizationId: 'org-1' });
    expect(body.assistantOverrides).toBeUndefined();
  });

  it('createCall() sends real assistantOverrides.firstMessage/model.messages when a per-lead override is resolved (Bug 1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'call_abc', status: 'queued' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VapiProvider('sk-test');
    await provider.createCall({
      callId: 'internal-call-1',
      organizationId: 'org-1',
      providerAssistantId: 'asst_123',
      agentVersionId: 'version-1',
      fromPhoneNumber: '+14845551111',
      fromPhoneNumberProviderId: 'vapi-pn-1',
      toPhoneNumber: '+14845552222',
      transferDestinationE164: null,
      firstMessageOverride: 'Hi, am I speaking with Priya?',
      systemPromptOverride: 'You are a helpful sales agent. This lead works at Acme Inc.',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.assistantOverrides).toEqual({
      firstMessage: 'Hi, am I speaking with Priya?',
      model: { messages: [{ role: 'system', content: 'You are a helpful sales agent. This lead works at Acme Inc.' }] },
    });
  });

  it('transferCall() refuses a non-E.164 destination without calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VapiProvider('sk-test');
    await expect(provider.transferCall('call_abc', 'not-a-number')).rejects.toBeInstanceOf(OrchestrationProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('transferCall() posts a transfer-call control message to the call monitor.controlUrl', async () => {
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === 'https://api.vapi.ai/call/call_abc') {
        return { ok: true, json: async () => ({ id: 'call_abc', status: 'in-progress', monitor: { controlUrl: 'https://vapi.example/control/xyz' } }) };
      }
      if (input === 'https://vapi.example/control/xyz') {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VapiProvider('sk-test');
    await provider.transferCall('call_abc', '+14845559999');

    const controlCall = fetchMock.mock.calls.find(([url]) => url === 'https://vapi.example/control/xyz');
    expect(controlCall).toBeDefined();
    const body = JSON.parse(controlCall![1]!.body as string);
    expect(body).toEqual({ type: 'transfer-call', destination: { type: 'number', number: '+14845559999' } });
  });

  it('getLiveMonitorUrls() relays monitor.listenUrl/controlUrl from the call object', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'call_abc', status: 'in-progress', monitor: { listenUrl: 'wss://listen', controlUrl: 'https://control' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VapiProvider('sk-test');
    const urls = await provider.getLiveMonitorUrls('call_abc');
    expect(urls).toEqual({ listenUrl: 'wss://listen', controlUrl: 'https://control', supportsWhisperBarge: true });
  });

  it('getArtifacts()/getTranscript()/getRecording() read from call.artifact', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'call_abc',
        status: 'ended',
        artifact: { recordingUrl: 'https://rec', transcriptUrl: 'https://tx', transcript: 'hello world' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VapiProvider('sk-test');
    expect(await provider.getArtifacts('call_abc')).toEqual({ recordingUrl: 'https://rec', transcriptUrl: 'https://tx', transcript: 'hello world', segments: null });
    expect(await provider.getTranscript('call_abc')).toBe('hello world');
    expect(await provider.getRecording('call_abc')).toBe('https://rec');
  });

  it('registerWebhook() PATCHes /org with the server url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VapiProvider('sk-test');
    await provider.registerWebhook('https://backend.example.com/api/v1/webhooks/vapi');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.vapi.ai/org');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ server: { url: 'https://backend.example.com/api/v1/webhooks/vapi' } });
  });

  it('a non-2xx response throws OrchestrationProviderError, never a silent success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VapiProvider('sk-test');
    await expect(provider.createAssistant(BASE_CONFIG)).rejects.toBeInstanceOf(OrchestrationProviderError);
  });
});
