import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
}));

const fake = createFakeSupabase();

const { repairOrganizationCallEndData } = await import('./callEndDataRepair.js');
const { registerTerminalCallHandler } = await import('../lib/callStateMachine.js');
const { handleTerminalCall } = await import('./callTerminalHandler.js');
const { __setOrchestrationProviderForTests } = await import('../lib/orchestration/index.js');
const { encryptCredentials } = await import('../lib/crypto/credentials.js');

registerTerminalCallHandler(handleTerminalCall);

/**
 * Regression coverage for a real historical data-corruption bug: a call
 * already terminal (status 'completed'/'transferred') with a blank
 * ended_at, left that way forever because the status-update/
 * end-of-call-report race (see routes/webhooks.ts's fix) discarded the
 * real end data. See services/callEndDataRepair.ts's header for the full
 * writeup.
 */
describe('callEndDataRepair', () => {
  const orgId = randomUUID();

  beforeEach(() => {
    fake.tables.organizations.length = 0;
    fake.tables.calls.length = 0;
    fake.tables.call_events.length = 0;
    fake.tables.call_dispositions.length = 0;
    fake.tables.campaign_leads.length = 0;
    fake.tables.vapi_credentials.length = 0;
    fake.tables.organizations.push({ id: orgId, name: 'Repair Co', slug: 'repair-co' });
    fake.tables.vapi_credentials.push({
      id: randomUUID(),
      organization_id: orgId,
      encrypted_credentials: encryptCredentials({ api_key: 'sk-test' }) as any,
      status: 'connected',
    });
    __setOrchestrationProviderForTests('vapi', null);
  });

  function brokenCall(overrides: Record<string, any> = {}) {
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
      status: 'completed',
      ended_at: null,
      duration_seconds: null,
      ended_reason: null,
      cost: null,
      ...overrides,
    });
    return id;
  }

  it('repairs a terminal call missing end data by fetching it from the provider, then re-runs disposition', async () => {
    const callId = brokenCall();
    __setOrchestrationProviderForTests('vapi', {
      async getCall() {
        const endedAt = new Date();
        const startedAt = new Date(endedAt.getTime() - 63 * 1000);
        return {
          status: 'ended',
          raw: { status: 'ended', endedReason: 'customer-ended-call', startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), cost: 0.5 },
        };
      },
    } as any);

    const result = await repairOrganizationCallEndData(fake.supabase as any, orgId);

    expect(result.checked).toBe(1);
    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(0);

    const call = fake.tables.calls.find((c) => c.id === callId)!;
    expect(call.status).toBe('completed'); // status itself never changes here
    expect(call.ended_reason).toBe('customer-ended-call');
    expect(call.duration_seconds).toBe(63);
    expect(call.cost).toBe(0.5);
    expect(call.ended_at).not.toBeNull();

    const disposition = fake.tables.call_dispositions.find((d) => d.call_id === callId);
    expect(disposition).toBeDefined();
    expect(disposition!.disposition_source).toBe('engine');
  });

  it('never touches a call whose end_at is already set', async () => {
    const callId = brokenCall({ ended_at: new Date().toISOString(), duration_seconds: 30 });
    const result = await repairOrganizationCallEndData(fake.supabase as any, orgId);
    expect(result.checked).toBe(0);
    const call = fake.tables.calls.find((c) => c.id === callId)!;
    expect(call.duration_seconds).toBe(30);
  });

  it('a provider error for one call is skipped, never corrupting that call or crashing the whole pass', async () => {
    const callId1 = brokenCall();
    const callId2 = brokenCall();
    let calls = 0;
    __setOrchestrationProviderForTests('vapi', {
      async getCall() {
        calls += 1;
        if (calls === 1) throw new Error('simulated Vapi API error');
        return { status: 'ended', raw: { status: 'ended', endedReason: 'customer-ended-call', endedAt: new Date().toISOString() } };
      },
    } as any);

    const result = await repairOrganizationCallEndData(fake.supabase as any, orgId);

    expect(result.checked).toBe(2);
    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(1);

    const endedAtValues = [callId1, callId2].map((id) => fake.tables.calls.find((c) => c.id === id)!.ended_at);
    expect(endedAtValues.filter((v) => v !== null)).toHaveLength(1);
  });

  it('skips every affected call when the org has no Vapi credentials, never throws', async () => {
    fake.tables.vapi_credentials.length = 0;
    brokenCall();
    const result = await repairOrganizationCallEndData(fake.supabase as any, orgId);
    expect(result.checked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.repaired).toBe(0);
  });
});
