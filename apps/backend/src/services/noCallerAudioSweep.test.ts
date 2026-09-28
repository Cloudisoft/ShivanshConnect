import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
}));

const fake = createFakeSupabase();

const { runNoCallerAudioSweep } = await import('./noCallerAudioSweep.js');
const { registerTerminalCallHandler } = await import('../lib/callStateMachine.js');
const { handleTerminalCall } = await import('./callTerminalHandler.js');
const { __setOrchestrationProviderForTests } = await import('../lib/orchestration/index.js');
const { encryptCredentials } = await import('../lib/crypto/credentials.js');

registerTerminalCallHandler(handleTerminalCall);

/**
 * services/noCallerAudioSweep.ts - the connected-but-no-caller-audio
 * backstop, per explicit request: "assistant didn't get sound or voice on
 * calls please resolve this... end the call without wasting any more
 * credits."
 */
describe('noCallerAudioSweep', () => {
  const orgId = randomUUID();

  beforeEach(() => {
    fake.tables.organizations.length = 0;
    fake.tables.calls.length = 0;
    fake.tables.call_events.length = 0;
    fake.tables.call_dispositions.length = 0;
    fake.tables.campaign_leads.length = 0;
    fake.tables.call_transcript_segments.length = 0;
    fake.tables.vapi_credentials.length = 0;
    fake.tables.organizations.push({ id: orgId, name: 'No Audio Co', slug: 'no-audio-co' });
    __setOrchestrationProviderForTests('vapi', null);
  });

  function call(overrides: Record<string, any> = {}) {
    const id = randomUUID();
    fake.tables.calls.push({
      id,
      organization_id: orgId,
      engine: 'vapi',
      vapi_call_id: `vapi_${id}`,
      ai_agent_id: randomUUID(),
      ai_agent_version_id: randomUUID(),
      phone_number_id: randomUUID(),
      direction: 'outbound',
      customer_number: '+12015551234',
      status: 'in_progress',
      answered_at: new Date(Date.now() - 120 * 1000).toISOString(), // 120s ago - past the 90s default
      ...overrides,
    });
    return id;
  }

  it('disposes a connected call with zero caller transcript segments past the timeout', async () => {
    const id = call();
    const result = await runNoCallerAudioSweep();
    expect(result.checked).toBe(1);
    expect(result.disposed).toBe(1);
    const c = fake.tables.calls.find((row) => row.id === id)!;
    expect(c.status).toBe('completed');
    expect(c.ended_reason).toBe('no_customer_audio');
  });

  it('never touches a call that has at least one real caller transcript segment', async () => {
    const id = call();
    fake.tables.call_transcript_segments.push({
      id: randomUUID(),
      transcript_id: randomUUID(),
      call_id: id,
      organization_id: orgId,
      speaker: 'caller',
      segment_index: 0,
      start_ms: 0,
      end_ms: 1000,
      text: 'Hello?',
    });
    const result = await runNoCallerAudioSweep();
    expect(result.checked).toBe(0);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('in_progress');
  });

  it('is not fooled by an AI-only transcript segment - only a real "caller" segment counts as real audio', async () => {
    const id = call();
    fake.tables.call_transcript_segments.push({
      id: randomUUID(),
      transcript_id: randomUUID(),
      call_id: id,
      organization_id: orgId,
      speaker: 'ai',
      segment_index: 0,
      start_ms: 0,
      end_ms: 1000,
      text: 'Hi there!',
    });
    const result = await runNoCallerAudioSweep();
    expect(result.checked).toBe(1);
    expect(result.disposed).toBe(1);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('completed');
  });

  it('never touches a call still under the timeout, even with zero caller audio so far', async () => {
    const id = call({ answered_at: new Date(Date.now() - 10 * 1000).toISOString() });
    const result = await runNoCallerAudioSweep();
    expect(result.checked).toBe(0);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('in_progress');
  });

  it('never touches a voicemail/answering_machine call - AMD already resolved those', async () => {
    const id = call({ status: 'voicemail' });
    const result = await runNoCallerAudioSweep();
    expect(result.checked).toBe(0);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('voicemail');
  });

  it('actually ends the call at the provider before disposing it locally - "end the call without wasting any more credits"', async () => {
    fake.tables.vapi_credentials.push({
      id: randomUUID(),
      organization_id: orgId,
      encrypted_credentials: encryptCredentials({ api_key: 'sk-test' }) as any,
      status: 'connected',
    });
    const endCall = vi.fn(async () => {});
    __setOrchestrationProviderForTests('vapi', {
      async createAssistant() {
        throw new Error('unused');
      },
      async createCall() {
        throw new Error('unused');
      },
      async getCall() {
        throw new Error('unused');
      },
      endCall,
      async transferCall() {},
      async importPhoneNumber() {
        throw new Error('unused');
      },
    } as any);

    const id = call();
    const result = await runNoCallerAudioSweep();

    expect(result.disposed).toBe(1);
    expect(endCall).toHaveBeenCalledWith(`vapi_${id}`);

    __setOrchestrationProviderForTests('vapi', null);
  });
});
