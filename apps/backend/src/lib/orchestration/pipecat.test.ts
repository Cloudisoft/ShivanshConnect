import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipecatProvider } from './pipecat.js';
import { OrchestrationProviderError, OrchestrationProviderNotConfiguredError, type AssistantConfig } from './types.js';

const BASE_CONFIG: AssistantConfig = {
  agentId: 'agent-1',
  agentVersionId: 'version-1',
  organizationId: 'org-1',
  name: 'Support Assistant',
  systemPrompt: 'You are a support agent.',
  greeting: 'Hello, how can I help?',
  personality: { tone: null, personality_traits: [], behavior_traits: [] },
  llmProvider: 'openai',
  llmModel: 'gpt-4o-mini',
  llmTemperature: 0.5,
  llmMaxTokens: 500,
  voice: null,
  transferRules: { on_no_match: 'end_call', transfer_to: null, conditions: [] },
  maxCallDurationSeconds: null,
};

describe('PipecatProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not configured without PIPECAT_SERVICE_URL', () => {
    expect(new PipecatProvider(undefined).isConfigured).toBe(false);
  });

  it('every method throws OrchestrationProviderNotConfiguredError when unset - never simulates a call', async () => {
    const provider = new PipecatProvider(undefined);
    await expect(provider.createAssistant(BASE_CONFIG)).rejects.toBeInstanceOf(OrchestrationProviderNotConfiguredError);
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
    ).rejects.toBeInstanceOf(OrchestrationProviderNotConfiguredError);
  });

  it('createAssistant() pings /health and returns a stable non-fabricated marker id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new PipecatProvider('http://localhost:8100');
    const result = await provider.createAssistant(BASE_CONFIG);
    expect(result.providerAssistantId).toBe('pipecat-agent-version:version-1');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8100/health', expect.objectContaining({ method: 'GET' }));
  });

  it('createCall() POSTs /calls with the agent version id and E.164 numbers, and passes through the Authorization bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pipecat_call_id: 'pc_1', status: 'dialing' }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new PipecatProvider('http://localhost:8100', 'internal-token');

    const result = await provider.createCall({
      callId: 'internal-call-1',
      organizationId: 'org-1',
      providerAssistantId: 'pipecat-agent-version:version-1',
      agentVersionId: 'version-1',
      fromPhoneNumber: '+14845551111',
      fromPhoneNumberProviderId: null,
      toPhoneNumber: '+14845552222',
      transferDestinationE164: '+14845559999',
      telephonyCredentials: { provider: 'twilio', accountSid: 'AC123', authToken: 'secret' },
    });

    expect(result).toEqual({ providerCallId: 'pc_1', status: 'dialing' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8100/calls');
    expect(init.headers.Authorization).toBe('Bearer internal-token');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      internal_call_id: 'internal-call-1',
      organization_id: 'org-1',
      agent_version_id: 'version-1',
      from_e164: '+14845551111',
      to_e164: '+14845552222',
      transfer_destination_e164: '+14845559999',
      telephony: { provider: 'twilio', account_sid: 'AC123', auth_token: 'secret', api_key: undefined },
    });
  });

  it('createCall() requires telephonyCredentials for the pipecat engine (never a simulated call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new PipecatProvider('http://localhost:8100');
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
    ).rejects.toBeInstanceOf(OrchestrationProviderNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 422 from pipecat-service surfaces as OrchestrationProviderNotConfiguredError (e.g. missing STT/TTS/LLM key)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'pipecat engine not configured: missing DEEPGRAM_API_KEY' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new PipecatProvider('http://localhost:8100');
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
        telephonyCredentials: { provider: 'telnyx', apiKey: 'key' },
      }),
    ).rejects.toBeInstanceOf(OrchestrationProviderNotConfiguredError);
  });

  it('a genuine 5xx from pipecat-service surfaces as OrchestrationProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new PipecatProvider('http://localhost:8100');
    await expect(provider.endCall('pc_1')).rejects.toBeInstanceOf(OrchestrationProviderError);
  });

  it('transferCall() refuses a non-E.164 destination without calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new PipecatProvider('http://localhost:8100');
    await expect(provider.transferCall('pc_1', 'not-e164')).rejects.toBeInstanceOf(OrchestrationProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getLiveMonitorUrls() honestly reports unsupported (Phase 10 territory), never fabricated URLs', async () => {
    const provider = new PipecatProvider('http://localhost:8100');
    expect(await provider.getLiveMonitorUrls('pc_1')).toEqual({ listenUrl: null, controlUrl: null, supportsWhisperBarge: false });
  });
});
