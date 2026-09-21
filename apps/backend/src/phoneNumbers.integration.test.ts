import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 5 integration test: connect Twilio credentials (HTTP mocked at the
 * fetch boundary only - real route/adapter code runs unmocked) ->
 * test-connection succeeds -> sync numbers -> list shows numbers scoped to
 * the connecting organization only (cross-org isolation) -> BYON manual
 * import creates a number with zero external calls -> duplicate E.164
 * import within the same org is rejected -> assigning a number to an
 * agent writes an audit log entry.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex, test-only

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

describe('Phase 5: telephony provider connect -> sync -> list, BYON import, dedupe, assignment audit', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === 'https://api.twilio.com/2010-04-01/Accounts/AC_TEST_SID.json' && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ sid: 'AC_TEST_SID' }) } as unknown as Response;
      }
      if (url === 'https://api.twilio.com/2010-04-01/Accounts/AC_TEST_SID/IncomingPhoneNumbers.json?PageSize=1000' && method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            incoming_phone_numbers: [
              { sid: 'PN111', phone_number: '+14845551111', friendly_name: 'Sales line', capabilities: { voice: true, sms: true, mms: false, fax: false } },
              { sid: 'PN222', phone_number: '+14845552222', friendly_name: 'Support line', capabilities: { voice: true, sms: false, mms: false, fax: false } },
            ],
          }),
        } as unknown as Response;
      }

      if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
        const body = JSON.parse((init?.body as string) ?? '{}');
        if (body.provider === 'byo-phone-number') {
          return { ok: true, json: async () => ({ id: `vapi-pn-${body.number}` }) } as unknown as Response;
        }
        throw new Error(`Unexpected Vapi phone-number import payload in test: ${JSON.stringify(body)}`);
      }

      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.session.access_token as string;
  }

  it('connects Twilio, syncs numbers, lists them scoped to the connecting org only', async () => {
    const tokenA = await signup('Numbers Org A', 'numbers-a@test.com');
    const tokenB = await signup('Numbers Org B', 'numbers-b@test.com');

    const catalogBefore = await app.inject({ method: 'GET', url: '/api/v1/phone-number-providers', headers: { authorization: `Bearer ${tokenA}` } });
    expect(catalogBefore.statusCode).toBe(200);
    const twilioEntry = catalogBefore.json().data.find((p: any) => p.key === 'twilio');
    expect(twilioEntry.status).toBe('not_connected');
    expect(twilioEntry.masked_credential).toBeNull();
    const byonEntry = catalogBefore.json().data.find((p: any) => p.key === 'byon');
    expect(byonEntry.is_manual_only).toBe(true);

    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-number-providers/twilio/credentials',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { account_sid: 'AC_TEST_SID', auth_token: 'super-secret-auth-token' },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(JSON.stringify(saveRes.json())).not.toContain('super-secret-auth-token');
    expect(saveRes.json().data.masked_credential).toContain('AC_T');

    const testRes = await app.inject({ method: 'POST', url: '/api/v1/phone-number-providers/twilio/test-connection', headers: { authorization: `Bearer ${tokenA}` } });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().data.success).toBe(true);
    expect(testRes.json().data.status).toBe('connected');

    const syncRes = await app.inject({ method: 'POST', url: '/api/v1/phone-numbers/sync/twilio', headers: { authorization: `Bearer ${tokenA}` } });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().data.created).toBe(2);

    const listA = await app.inject({ method: 'GET', url: '/api/v1/phone-numbers', headers: { authorization: `Bearer ${tokenA}` } });
    expect(listA.json().data).toHaveLength(2);
    expect(listA.json().data.map((n: any) => n.phone_number).sort()).toEqual(['+14845551111', '+14845552222']);

    // Org B never connected Twilio and never synced - its number list must
    // stay empty even though org A's sync just ran.
    const listB = await app.inject({ method: 'GET', url: '/api/v1/phone-numbers', headers: { authorization: `Bearer ${tokenB}` } });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().data).toHaveLength(0);
    const catalogB = await app.inject({ method: 'GET', url: '/api/v1/phone-number-providers', headers: { authorization: `Bearer ${tokenB}` } });
    expect(catalogB.json().data.find((p: any) => p.key === 'twilio').status).toBe('not_connected');

    // Re-syncing does not duplicate - both rows are updated, not re-inserted.
    const resyncRes = await app.inject({ method: 'POST', url: '/api/v1/phone-numbers/sync/twilio', headers: { authorization: `Bearer ${tokenA}` } });
    expect(resyncRes.json().data.created).toBe(0);
    expect(resyncRes.json().data.updated).toBe(2);
    const listAfterResync = await app.inject({ method: 'GET', url: '/api/v1/phone-numbers', headers: { authorization: `Bearer ${tokenA}` } });
    expect(listAfterResync.json().data).toHaveLength(2);
  });

  it('BYON manual import creates a number with zero external calls, and rejects an invalid E.164', async () => {
    const token = await signup('BYON Org', 'byon-owner@test.com');
    const fetchCallsBefore = (globalThis.fetch as any).mock.calls.length;

    const invalidRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider_key: 'byon', phone_number: 'not-a-number', capabilities: { voice_inbound: true, voice_outbound: true, sms: false } },
    });
    expect(invalidRes.statusCode).toBe(422); // invalid user input -> mapped to a client-actionable 422, not a provider outage
    expect(fake.tables.phone_numbers.some((n) => n.organization_id && n.phone_number === 'not-a-number')).toBe(false);

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider_key: 'byon',
        phone_number: '(484) 555-9999',
        friendly_name: 'SIP trunk line',
        capabilities: { voice_inbound: true, voice_outbound: true, sms: false },
        sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' },
      },
    });
    expect(importRes.statusCode).toBe(200);
    expect(importRes.json().data.phone_number).toBe('+14845559999');
    expect(importRes.json().data.provider_number_id).toBeNull();
    // The SIP password must never be echoed back, even encrypted.
    expect(JSON.stringify(importRes.json())).not.toContain('trunk-secret');
    expect(importRes.json().data.sip_trunk_metadata).toEqual({ host: 'sip.example.com', username: 'trunk-user' });

    // BYON never makes a network call.
    expect((globalThis.fetch as any).mock.calls.length).toBe(fetchCallsBefore);

    // A second import of the same E.164 for the same org is rejected.
    const dupeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider_key: 'byon', phone_number: '+14845559999', capabilities: { voice_inbound: true, voice_outbound: true, sms: false } },
    });
    expect(dupeRes.statusCode).toBe(409);
    expect(dupeRes.json().error.message).toMatch(/already registered/i);
  });

  it('assigning a number to an agent writes an audit log entry', async () => {
    const token = await signup('Assign Org', 'assign-owner@test.com');

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider_key: 'byon', phone_number: '+14845557777', capabilities: { voice_inbound: true, voice_outbound: true, sms: false } },
    });
    const numberId = importRes.json().data.id;

    const agentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Inbound Agent', role: 'sales_agent' },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json().data.id;

    const assignRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/phone-numbers/${numberId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assigned_agent_id: agentId },
    });
    expect(assignRes.statusCode).toBe(200);
    expect(assignRes.json().data.assigned_agent_id).toBe(agentId);

    const auditEntry = fake.tables.audit_logs.find((a) => a.action === 'phone_number.updated' && a.entity_id === numberId);
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.new_value.assigned_agent_id).toBe(agentId);

    // Deleting only removes it from the local registry - never a carrier
    // release for a real Twilio/Telnyx number, and the response says so.
    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/v1/phone-numbers/${numberId}`, headers: { authorization: `Bearer ${token}` } });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().data.deleted).toBe(true);
  });

  it('a BYON import is not synced with Vapi when Vapi is not connected for this org - no error, just no id', async () => {
    const token = await signup('No Vapi Org', 'no-vapi@test.com');

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider_key: 'byon',
        phone_number: '+14845558888',
        capabilities: { voice_inbound: true, voice_outbound: true, sms: false },
        sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' },
      },
    });
    expect(importRes.statusCode).toBe(200);
    expect(importRes.json().data.vapi_phone_number_id).toBeNull();
    expect(importRes.json().message).not.toMatch(/vapi/i);
  });

  it('a BYON import with a SIP trunk is automatically synced with Vapi once Vapi is connected', async () => {
    const token = await signup('Auto Vapi Sync Org', 'auto-vapi-sync@test.com');

    const vapiCredsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vapi/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { api_key: 'vapi-test-key' },
    });
    expect(vapiCredsRes.statusCode).toBe(200);

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider_key: 'byon',
        phone_number: '+14845556666',
        capabilities: { voice_inbound: true, voice_outbound: true, sms: false },
        sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' },
      },
    });
    expect(importRes.statusCode).toBe(200);
    expect(importRes.json().data.vapi_phone_number_id).toBe('vapi-pn-+14845556666');
    expect(importRes.json().message).toMatch(/synced with vapi/i);
  });

  it('POST /:id/sync-vapi is an explicit, honest action: it reports real failures instead of swallowing them', async () => {
    const token = await signup('Manual Vapi Sync Org', 'manual-vapi-sync@test.com');

    const vapiCredsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vapi/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { api_key: 'vapi-test-key' },
    });
    expect(vapiCredsRes.statusCode).toBe(200);

    // Imported with NO sip_trunk_metadata - cannot be synced to Vapi.
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider_key: 'byon', phone_number: '+14845554444', capabilities: { voice_inbound: true, voice_outbound: true, sms: false } },
    });
    expect(importRes.json().data.vapi_phone_number_id).toBeNull();
    const numberId = importRes.json().data.id;

    const syncRes = await app.inject({ method: 'POST', url: `/api/v1/phone-numbers/${numberId}/sync-vapi`, headers: { authorization: `Bearer ${token}` } });
    expect(syncRes.statusCode).toBe(422);
    expect(syncRes.json().error.message).toMatch(/SIP trunk/i);
  });

  it('POST /phone-numbers/bulk-actions bulk-deletes and bulk-assigns, scoped cross-org', async () => {
    const tokenA = await signup('Bulk Numbers Org A', 'bulk-numbers-a@test.com');
    const tokenB = await signup('Bulk Numbers Org B', 'bulk-numbers-b@test.com');

    async function importByon(token: string, phone: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/phone-numbers/import',
        headers: { authorization: `Bearer ${token}` },
        payload: { provider_key: 'byon', phone_number: phone, capabilities: { voice_inbound: true, voice_outbound: true, sms: false } },
      });
      return res.json().data.id as string;
    }

    const numberA1 = await importByon(tokenA, '+14845551001');
    const numberA2 = await importByon(tokenA, '+14845551002');

    // Org B cannot bulk-act on Org A's numbers - scoped out, affected=0.
    const crossOrgAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/bulk-actions',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { phone_number_ids: [numberA1, numberA2], action: 'delete' },
    });
    expect(crossOrgAttempt.statusCode).toBe(200);
    expect(crossOrgAttempt.json().data.affected).toBe(0);

    const agentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Bulk Assign Agent', role: 'sales_agent' },
    });
    const agentId = agentRes.json().data.id;

    const assignRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/bulk-actions',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { phone_number_ids: [numberA1, numberA2], action: 'assign_agent', assigned_agent_id: agentId },
    });
    expect(assignRes.statusCode).toBe(200);
    expect(assignRes.json().data.affected).toBe(2);

    const listAfterAssign = await app.inject({ method: 'GET', url: '/api/v1/phone-numbers', headers: { authorization: `Bearer ${tokenA}` } });
    expect(listAfterAssign.json().data.every((n: any) => n.assigned_agent_id === agentId)).toBe(true);

    const deleteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/bulk-actions',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { phone_number_ids: [numberA1, numberA2], action: 'delete' },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().data.affected).toBe(2);

    const listAfterDelete = await app.inject({ method: 'GET', url: '/api/v1/phone-numbers', headers: { authorization: `Bearer ${tokenA}` } });
    expect(listAfterDelete.json().data).toHaveLength(0);
  });
});
