import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
}));

const fake = createFakeSupabase();

const { originateCall } = await import('./callOrigination.js');
const { __setOrchestrationProviderForTests } = await import('../lib/orchestration/index.js');
const { encryptCredentials } = await import('../lib/crypto/credentials.js');

/**
 * Bug 1 regression coverage: real per-lead variable substitution + the
 * named-vs-unnamed greeting branch, proven end-to-end through
 * originateCall() -> the (fake/mocked) Vapi adapter's createCall(), the
 * same way a real call is placed. Also covers Bug 2's voicemail/
 * background-noise wiring and the pre-existing voice-override
 * regression test the task explicitly asked for.
 */
describe('originateCall - per-lead personalization (Bug 1) and campaign config forwarding (Bug 2)', () => {
  const orgId = randomUUID();
  let agentId: string;
  let versionId: string;
  let phoneNumberId: string;

  beforeEach(() => {
    fake.tables.organizations.length = 0;
    fake.tables.leads.length = 0;
    fake.tables.ai_agents.length = 0;
    fake.tables.ai_agent_versions.length = 0;
    fake.tables.campaigns.length = 0;
    fake.tables.voices.length = 0;
    fake.tables.phone_numbers.length = 0;
    fake.tables.vapi_credentials.length = 0;
    fake.tables.calls.length = 0;
    fake.tables.call_events.length = 0;
    fake.tables.audit_logs.length = 0;

    fake.tables.organizations.push({ id: orgId, name: 'Acme Sales Co', slug: 'acme-sales' });
    fake.tables.vapi_credentials.push({
      id: randomUUID(),
      organization_id: orgId,
      encrypted_credentials: encryptCredentials({ api_key: 'sk-test' }) as any,
      status: 'connected',
    });

    agentId = randomUUID();
    fake.tables.ai_agents.push({ id: agentId, organization_id: orgId, name: 'Sales Agent' });

    versionId = randomUUID();
    fake.tables.ai_agent_versions.push({
      id: versionId,
      agent_id: agentId,
      organization_id: orgId,
      version_number: 1,
      system_prompt: 'You are a helpful sales agent. Reach out to {{email}} if needed.',
      greeting_template: 'Hi, am I speaking with {{first_name}}?',
      vapi_assistant_id: null,
      status: 'published',
    });

    phoneNumberId = randomUUID();
    fake.tables.phone_numbers.push({
      id: phoneNumberId,
      organization_id: orgId,
      provider_key: 'twilio',
      phone_number: '+14845551111',
      vapi_phone_number_id: 'vapi-pn-already-imported',
    });

    __setOrchestrationProviderForTests('vapi', null);
  });

  function fakeVapiProvider() {
    const createAssistant = vi.fn().mockResolvedValue({ providerAssistantId: 'asst_fresh' });
    const createCall = vi.fn().mockResolvedValue({ providerCallId: 'call_abc', status: 'queued' });
    __setOrchestrationProviderForTests('vapi', {
      key: 'vapi',
      name: 'Vapi',
      isConfigured: true,
      createAssistant,
      updateAssistant: vi.fn(),
      createCall,
      getCall: vi.fn(),
      endCall: vi.fn(),
      transferCall: vi.fn(),
      getArtifacts: vi.fn(),
      getTranscript: vi.fn(),
      getRecording: vi.fn(),
      getLiveMonitorUrls: vi.fn(),
      registerWebhook: vi.fn(),
      importPhoneNumber: vi.fn(),
    } as any);
    return { createAssistant, createCall };
  }

  it('a named lead gets the greeting_template rendered with real lead data, not the raw template', async () => {
    const { createCall } = fakeVapiProvider();
    const leadId = randomUUID();
    fake.tables.leads.push({
      id: leadId,
      organization_id: orgId,
      first_name: 'Priya',
      last_name: 'Shah',
      phone_normalized: '+14845552222',
      email: 'priya@acme.example',
      custom_fields: {},
    });

    fake.tables.ai_agent_versions[0].vapi_assistant_id = 'asst_existing';

    await originateCall({
      organizationId: orgId,
      engine: 'vapi',
      agent: { id: agentId },
      version: fake.tables.ai_agent_versions[0],
      phoneNumber: fake.tables.phone_numbers[0],
      customerNumber: '+14845552222',
      leadId,
      campaignId: null,
      createdBy: null,
    });

    expect(createCall).toHaveBeenCalledTimes(1);
    const params = createCall.mock.calls[0][0];
    expect(params.firstMessageOverride).toBe('Hi, am I speaking with Priya?');
    expect(params.systemPromptOverride).toBe('You are a helpful sales agent. Reach out to priya@acme.example if needed.');
  });

  it('an unnamed lead gets the generic fallback greeting with the real voice + campaign name, not the named template', async () => {
    const { createCall } = fakeVapiProvider();
    const leadId = randomUUID();
    fake.tables.leads.push({
      id: leadId,
      organization_id: orgId,
      first_name: '',
      last_name: '',
      phone_normalized: '+14845552222',
      email: 'unknown@acme.example',
      custom_fields: {},
    });

    const voiceId = randomUUID();
    fake.tables.voices.push({ id: voiceId, organization_id: orgId, provider_key: 'elevenlabs', provider_voice_id: 'voice-1', name: 'Sarah' });
    fake.tables.ai_agent_versions[0].voice_id = voiceId;
    fake.tables.ai_agent_versions[0].vapi_assistant_id = 'asst_existing';

    const campaignId = randomUUID();
    fake.tables.campaigns.push({ id: campaignId, organization_id: orgId, name: 'Fall Outreach' });

    await originateCall({
      organizationId: orgId,
      engine: 'vapi',
      agent: { id: agentId },
      version: fake.tables.ai_agent_versions[0],
      phoneNumber: fake.tables.phone_numbers[0],
      customerNumber: '+14845552222',
      leadId,
      campaignId,
      createdBy: null,
    });

    const params = createCall.mock.calls[0][0];
    expect(params.firstMessageOverride).toBe('Hi, my name is Sarah from Fall Outreach. How are you doing today?');
    expect(params.systemPromptOverride).toContain('You are a helpful sales agent.');
    expect(params.systemPromptOverride).toContain('politely ask for their name');
  });

  it('a manual call with no leadId at all gets the same generic fallback greeting', async () => {
    const { createCall } = fakeVapiProvider();
    fake.tables.ai_agent_versions[0].vapi_assistant_id = 'asst_existing';

    await originateCall({
      organizationId: orgId,
      engine: 'vapi',
      agent: { id: agentId },
      version: fake.tables.ai_agent_versions[0],
      phoneNumber: fake.tables.phone_numbers[0],
      customerNumber: '+14845559999',
      leadId: null,
      campaignId: null,
      createdBy: null,
    });

    const params = createCall.mock.calls[0][0];
    // No campaign and no lead -> falls back to the agent's own name.
    expect(params.firstMessageOverride).toBe('Hi, my name is your assistant from Sales Agent. How are you doing today?');
  });

  it('originateCall() invokes createCall() with the correct assistantOverrides for a named lead (integration)', async () => {
    const { createCall } = fakeVapiProvider();
    const leadId = randomUUID();
    fake.tables.leads.push({
      id: leadId,
      organization_id: orgId,
      first_name: 'Dan',
      last_name: '',
      phone_normalized: '+14845552222',
      email: '',
      custom_fields: {},
    });
    fake.tables.ai_agent_versions[0].vapi_assistant_id = 'asst_existing';

    const result = await originateCall({
      organizationId: orgId,
      engine: 'vapi',
      agent: { id: agentId },
      version: fake.tables.ai_agent_versions[0],
      phoneNumber: fake.tables.phone_numbers[0],
      customerNumber: '+14845552222',
      leadId,
      campaignId: null,
      createdBy: null,
    });

    expect(result.call.vapi_call_id).toBe('call_abc');
    expect(createCall).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAssistantId: 'asst_existing',
        firstMessageOverride: 'Hi, am I speaking with Dan?',
      }),
    );
  });

  it('a campaign call forwards voicemail detection + background noise onto a freshly-built assistant (Bug 2)', async () => {
    const { createAssistant } = fakeVapiProvider();
    const leadId = randomUUID();
    fake.tables.leads.push({
      id: leadId,
      organization_id: orgId,
      first_name: 'Dan',
      phone_normalized: '+14845552222',
      custom_fields: {},
    });
    fake.tables.ai_agent_versions[0].vapi_assistant_id = 'asst_existing';
    const campaignId = randomUUID();
    fake.tables.campaigns.push({ id: campaignId, organization_id: orgId, name: 'Fall Outreach' });

    await originateCall({
      organizationId: orgId,
      engine: 'vapi',
      agent: { id: agentId },
      version: fake.tables.ai_agent_versions[0],
      phoneNumber: fake.tables.phone_numbers[0],
      customerNumber: '+14845552222',
      leadId,
      campaignId,
      createdBy: null,
      callingRulesOverride: {
        voicemail_detection_enabled: true,
        voicemail_message: 'Please call us back.',
        leave_voicemail: true,
        background_noise: 'high',
      },
    });

    expect(createAssistant).toHaveBeenCalledTimes(1);
    const config = createAssistant.mock.calls[0][0];
    expect(config.voicemailDetection).toEqual({ enabled: true, leaveVoicemail: true, message: 'Please call us back.' });
    expect(config.backgroundNoise).toBe('high');
  });

  it('a campaign voice override results in createAssistant()/createCall() using THAT override, not the agent default voice', async () => {
    const { createAssistant } = fakeVapiProvider();
    const leadId = randomUUID();
    fake.tables.leads.push({ id: leadId, organization_id: orgId, first_name: 'Dan', phone_normalized: '+14845552222', custom_fields: {} });

    const defaultVoiceId = randomUUID();
    fake.tables.voices.push({ id: defaultVoiceId, organization_id: orgId, provider_key: 'elevenlabs', provider_voice_id: 'default-voice', name: 'Default Voice' });
    fake.tables.ai_agent_versions[0].voice_id = defaultVoiceId;
    fake.tables.ai_agent_versions[0].vapi_assistant_id = 'asst_existing';

    const campaignId = randomUUID();
    fake.tables.campaigns.push({ id: campaignId, organization_id: orgId, name: 'Fall Outreach' });

    await originateCall({
      organizationId: orgId,
      engine: 'vapi',
      agent: { id: agentId },
      version: fake.tables.ai_agent_versions[0],
      phoneNumber: fake.tables.phone_numbers[0],
      customerNumber: '+14845552222',
      leadId,
      campaignId,
      createdBy: null,
      voiceOverride: { providerKey: 'cartesia', providerVoiceId: 'override-voice' },
    });

    expect(createAssistant).toHaveBeenCalledTimes(1);
    const config = createAssistant.mock.calls[0][0];
    expect(config.voice).toEqual({ providerKey: 'cartesia', providerVoiceId: 'override-voice' });
    // Never the agent's own default voice.
    expect(config.voice).not.toEqual({ providerKey: 'elevenlabs', providerVoiceId: 'default-voice' });
  });
});
