import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
}));

const fake = createFakeSupabase();

const { reconcileOrganizationCalls } = await import('./callReconciliation.js');
const { registerTerminalCallHandler } = await import('../lib/callStateMachine.js');
const { handleTerminalCall } = await import('./callTerminalHandler.js');
const { __setOrchestrationProviderForTests } = await import('../lib/orchestration/index.js');
const { encryptCredentials } = await import('../lib/crypto/credentials.js');

registerTerminalCallHandler(handleTerminalCall);

/**
 * Phase 15: services/callReconciliation.ts - the stuck-call safety net
 * (master spec section 73). Not built by any prior phase (Phase 6-8 relied
 * entirely on webhook delivery) - built fresh here.
 */
describe('callReconciliation', () => {
  const orgId = randomUUID();

  beforeEach(() => {
    fake.tables.organizations.length = 0;
    fake.tables.calls.length = 0;
    fake.tables.call_events.length = 0;
    fake.tables.call_dispositions.length = 0;
    fake.tables.campaign_leads.length = 0;
    fake.tables.vapi_credentials.length = 0;
    fake.tables.organizations.push({ id: orgId, name: 'Reconciliation Co', slug: 'reconciliation-co' });
    fake.tables.vapi_credentials.push({
      id: randomUUID(),
      organization_id: orgId,
      encrypted_credentials: encryptCredentials({ api_key: 'sk-test' }) as any,
      status: 'connected',
    });
    __setOrchestrationProviderForTests('vapi', null);
    __setOrchestrationProviderForTests('pipecat', null);
  });

  function stuckCall(overrides: Record<string, any> = {}) {
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
      created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 minutes ago
      ...overrides,
    });
    return id;
  }

  it('repairs a call the provider reports as genuinely ended - transitions it through the real state machine, never bypassing it', async () => {
    const callId = stuckCall();
    __setOrchestrationProviderForTests('vapi', {
      async createAssistant() {
        throw new Error('unused');
      },
      async createCall() {
        throw new Error('unused');
      },
      async getCall() {
        const endedAt = new Date();
        const startedAt = new Date(endedAt.getTime() - 47 * 1000);
        return {
          status: 'ended',
          raw: { status: 'ended', endedReason: 'customer-ended-call', startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), cost: 0.42 },
        };
      },
      async endCall() {},
      async transferCall() {},
      async importPhoneNumber() {
        throw new Error('unused');
      },
    } as any);

    const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = await reconcileOrganizationCalls(fake.supabase as any, orgId, stuckBefore);

    expect(result.checked).toBe(1);
    expect(result.repaired).toBe(1);
    expect(result.stillActive).toBe(0);

    const call = fake.tables.calls.find((c) => c.id === callId)!;
    expect(call.status).toBe('completed');
    expect(call.ended_reason).toBe('customer-ended-call');
    expect(call.cost).toBe(0.42);
    // Bug fix: this used to leave duration_seconds null on every
    // reconciliation-repaired call, which the disposition engine reads as
    // "no meaningful interaction" and misclassifies as DISCONNECTED/
    // HUNG_UP even for a real, successfully connected call - derived here
    // from the provider's own startedAt/endedAt, same as this fixture's
    // real 47-second gap between them.
    expect(call.duration_seconds).toBe(47);
  });

  it('leaves a call the provider still reports as active completely alone', async () => {
    const callId = stuckCall();
    __setOrchestrationProviderForTests('vapi', {
      async createAssistant() {
        throw new Error('unused');
      },
      async createCall() {
        throw new Error('unused');
      },
      async getCall() {
        return { status: 'in-progress', raw: { status: 'in-progress' } };
      },
      async endCall() {},
      async transferCall() {},
      async importPhoneNumber() {
        throw new Error('unused');
      },
    } as any);

    const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = await reconcileOrganizationCalls(fake.supabase as any, orgId, stuckBefore);

    expect(result.checked).toBe(1);
    expect(result.repaired).toBe(0);
    expect(result.stillActive).toBe(1);

    const call = fake.tables.calls.find((c) => c.id === callId)!;
    expect(call.status).toBe('in_progress'); // untouched
  });

  it('never touches a call that has not been stuck long enough (created after the stuckBefore cutoff)', async () => {
    const callId = stuckCall({ created_at: new Date().toISOString() }); // just now
    const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const result = await reconcileOrganizationCalls(fake.supabase as any, orgId, stuckBefore);

    expect(result.checked).toBe(0);
    const call = fake.tables.calls.find((c) => c.id === callId)!;
    expect(call.status).toBe('in_progress');
  });

  it('a provider error for one call is skipped, never corrupting that call or crashing the whole reconciliation pass', async () => {
    const callId1 = stuckCall();
    const callId2 = stuckCall();
    let calls = 0;
    __setOrchestrationProviderForTests('vapi', {
      async createAssistant() {
        throw new Error('unused');
      },
      async createCall() {
        throw new Error('unused');
      },
      async getCall() {
        calls += 1;
        if (calls === 1) throw new Error('simulated Vapi API error');
        return { status: 'ended', raw: { status: 'ended', endedReason: 'customer-ended-call' } };
      },
      async endCall() {},
      async transferCall() {},
      async importPhoneNumber() {
        throw new Error('unused');
      },
    } as any);

    const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = await reconcileOrganizationCalls(fake.supabase as any, orgId, stuckBefore);

    expect(result.checked).toBe(2);
    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(1);

    const statuses = [callId1, callId2].map((id) => fake.tables.calls.find((c) => c.id === id)!.status).sort();
    expect(statuses).toEqual(['completed', 'in_progress'].sort());
  });

  it('force-fails a call the provider still reports active once it exceeds the hard timeout - real production incident: 5 calls stuck Dialing/In Progress for 17+ minutes permanently blocked their campaign\'s concurrency', async () => {
    const callId = stuckCall({ created_at: new Date(Date.now() - 50 * 60 * 1000).toISOString() }); // 50 minutes ago
    __setOrchestrationProviderForTests('vapi', {
      async createAssistant() {
        throw new Error('unused');
      },
      async createCall() {
        throw new Error('unused');
      },
      async getCall() {
        return { status: 'in-progress', raw: { status: 'in-progress' } }; // Vapi still insists it's active
      },
      async endCall() {},
      async transferCall() {},
      async importPhoneNumber() {
        throw new Error('unused');
      },
    } as any);

    const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const hardStuckBefore = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const result = await reconcileOrganizationCalls(fake.supabase as any, orgId, stuckBefore, hardStuckBefore);

    expect(result.checked).toBe(1);
    expect(result.repaired).toBe(1); // force-failed, counted as repaired - the slot is freed either way
    expect(result.stillActive).toBe(0);

    const call = fake.tables.calls.find((c) => c.id === callId)!;
    expect(call.status).toBe('failed');
    expect(call.ended_reason).toBe('reconciliation_hard_timeout');
  });

  it('never force-fails a call still under the hard timeout even if the provider reports it active (the polite path gets many more chances first)', async () => {
    const callId = stuckCall(); // 20 minutes ago - past stuckBefore but well under a 45-minute hard timeout
    __setOrchestrationProviderForTests('vapi', {
      async createAssistant() {
        throw new Error('unused');
      },
      async createCall() {
        throw new Error('unused');
      },
      async getCall() {
        return { status: 'in-progress', raw: { status: 'in-progress' } };
      },
      async endCall() {},
      async transferCall() {},
      async importPhoneNumber() {
        throw new Error('unused');
      },
    } as any);

    const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const hardStuckBefore = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const result = await reconcileOrganizationCalls(fake.supabase as any, orgId, stuckBefore, hardStuckBefore);

    expect(result.repaired).toBe(0);
    expect(result.stillActive).toBe(1);
    const call = fake.tables.calls.find((c) => c.id === callId)!;
    expect(call.status).toBe('in_progress');
  });
});
