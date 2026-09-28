import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
}));

process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const fake = createFakeSupabase();

const { runDialTimeoutSweep } = await import('./dialTimeoutSweep.js');
const { registerTerminalCallHandler } = await import('../lib/callStateMachine.js');
const { handleTerminalCall } = await import('./callTerminalHandler.js');
const { __setOrchestrationProviderForTests } = await import('../lib/orchestration/index.js');
const { encryptCredentials } = await import('../lib/crypto/credentials.js');

registerTerminalCallHandler(handleTerminalCall);

/**
 * services/dialTimeoutSweep.ts - the fast (~80s) dial-connect timeout,
 * per explicit request: "if the calls are stuck for 1m 20 seconds
 * dispose it off unless and until it's really having conversations...
 * don't keep calls occupied for 10 mins in Live monitor."
 */
describe('dialTimeoutSweep', () => {
  const orgId = randomUUID();

  beforeEach(() => {
    fake.tables.organizations.length = 0;
    fake.tables.calls.length = 0;
    fake.tables.call_events.length = 0;
    fake.tables.call_dispositions.length = 0;
    fake.tables.campaign_leads.length = 0;
    fake.tables.organizations.push({ id: orgId, name: 'Dial Timeout Co', slug: 'dial-timeout-co' });
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
      status: 'dialing',
      answered_at: null,
      created_at: new Date(Date.now() - 100 * 1000).toISOString(), // 100s ago - past the 80s default
      ...overrides,
    });
    return id;
  }

  it('disposes a call still dialing/ringing/queued with no answered_at past the timeout', () => {
    const id1 = call({ status: 'dialing' });
    const id2 = call({ status: 'ringing' });
    const id3 = call({ status: 'queued' });
    return runDialTimeoutSweep().then((result) => {
      expect(result.checked).toBe(3);
      expect(result.disposed).toBe(3);
      for (const id of [id1, id2, id3]) {
        const c = fake.tables.calls.find((row) => row.id === id)!;
        expect(c.status).toBe('failed');
        expect(c.ended_reason).toBe('dial_timeout');
      }
    });
  });

  it('never touches a call that has already connected (answered_at set) - "unless it\'s really having conversations"', async () => {
    const id = call({ status: 'in_progress', answered_at: new Date(Date.now() - 100 * 1000).toISOString() });
    const result = await runDialTimeoutSweep();
    expect(result.checked).toBe(0);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('in_progress');
  });

  it('never touches a call still under the timeout, even if not yet connected', async () => {
    const id = call({ status: 'dialing', created_at: new Date(Date.now() - 10 * 1000).toISOString() }); // 10s ago
    const result = await runDialTimeoutSweep();
    expect(result.checked).toBe(0);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('dialing');
  });

  it('never touches a call that connected to voicemail/an answering machine - those statuses are excluded even without answered_at', async () => {
    const id = call({ status: 'voicemail' });
    const result = await runDialTimeoutSweep();
    expect(result.checked).toBe(0);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('voicemail');
  });

  it('actually ends the call at the provider before disposing it locally - "end the call without wasting any more credits"', async () => {
    fake.tables.vapi_credentials.length = 0;
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

    const id = call({ status: 'dialing' });
    const result = await runDialTimeoutSweep();

    expect(result.disposed).toBe(1);
    expect(endCall).toHaveBeenCalledWith(`vapi_${id}`);
    expect(fake.tables.calls.find((c) => c.id === id)!.status).toBe('failed');

    __setOrchestrationProviderForTests('vapi', null);
  });
});
