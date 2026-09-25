import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 10 integration tests: Live Monitor supervisor actions
 * (listen/whisper/barge/transfer/end) driven end to end through real
 * route handlers (app.inject()), against the same fakeSupabase harness
 * every prior phase's integration test uses.
 *
 * Covers, per the task brief:
 *  - permission gating: an AGENT (only live_monitor.view) is rejected on
 *    barge/whisper/listen/transfer/end; a MANAGER (has listen/barge/
 *    whisper) succeeds.
 *  - org scoping: a call belonging to a different organization 404s,
 *    never leaking existence or allowing the action.
 *  - transfer-destination validation reused correctly from Phase 6: a
 *    supervisor cannot transfer to a destination other than the call's
 *    own server-resolved transfer_destination_e164.
 *  - audit logging on every supervisor action.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.PIPECAT_SERVICE_TOKEN = 'test-pipecat-shared-secret';
process.env.BACKEND_PUBLIC_URL = 'http://localhost:4000';

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

let vapiCallCounter = 0;
let vapiAssistantCounter = 0;
let vapiPhoneNumberCounter = 0;

describe('Phase 10: Live Monitor supervisor actions', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === 'https://api.vapi.ai/assistant' && method === 'POST') {
        vapiAssistantCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p10_asst_${vapiAssistantCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
        vapiPhoneNumberCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p10_vapi_pn_${vapiPhoneNumberCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/call' && method === 'POST') {
        vapiCallCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p10_vapi_call_${vapiCallCounter}`, status: 'ringing' }) } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/assistant?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/call/') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: url.split('/').pop(),
            status: 'in-progress',
            monitor: { listenUrl: 'wss://vapi.example.com/listen/abc', controlUrl: 'https://vapi.example.com/control/abc' },
          }),
        } as unknown as Response;
      }
      if (url === 'https://vapi.example.com/control/abc' && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/call/') && url.endsWith('/hangup') && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return { token: res.json().data.session.access_token as string, userId: res.json().data.user.id as string };
  }

  // Resolved once per test run with the harness's own bootstrap admin
  // token (see beforeAll) - never with a per-org token, because after
  // setRole() downgrades a user away from roles.manage they can no
  // longer list roles themselves (that's the point of the permission
  // gating this file tests).
  const roleIds: Record<string, string> = {};

  async function resolveRoleIds(token: string) {
    if (Object.keys(roleIds).length > 0) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/roles', headers: { authorization: `Bearer ${token}` } });
    for (const role of res.json().data as any[]) {
      roleIds[role.name] = role.id;
    }
  }

  /** Changes `userId`'s role using the ORG OWNER's (never-downgraded)
   * token - a supervisor test user's own token would lose users.manage
   * the moment they're set to AGENT/MANAGER, which is the exact
   * permission boundary this file is testing, so role changes always go
   * through a separate, permanently-SUPER_ADMIN identity. */
  async function setRole(adminToken: string, userId: string, roleName: string) {
    await resolveRoleIds(adminToken);
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${userId}`, headers: { authorization: `Bearer ${adminToken}` }, payload: { role_id: roleIds[roleName] } });
    expect(res.statusCode).toBe(200);
  }

  /** Invites and accepts a second teammate into the SAME organization -
   * the "supervisor" whose role this file flips between AGENT and
   * MANAGER to exercise permission gating, always via the org owner's
   * own untouched token. */
  async function inviteSupervisor(adminToken: string, email: string) {
    await resolveRoleIds(adminToken);
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email, role_id: roleIds.AGENT },
    });
    expect(inviteRes.statusCode).toBe(201);
    const invitationToken = inviteRes.json().data.invitation.token;
    const acceptRes = await app.inject({ method: 'POST', url: '/api/v1/auth/accept-invitation', payload: { token: invitationToken, full_name: 'Supervisor', password: 'supersecret123' } });
    expect(acceptRes.statusCode).toBe(200);
    return { token: acceptRes.json().data.session.access_token as string, userId: fake.tables.users.find((u: any) => u.email === email)!.id as string };
  }

  async function setUpOrgWithLiveCall(orgName: string, email: string, transferTo: string | null) {
    const { token } = await signup(orgName, email);
    const agentRes = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Live Monitor Agent', role: 'sales_agent' } });
    const agent = agentRes.json().data;
    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'You are a helpful sales agent.', greeting_template: 'Hi there!', transfer_rules: { on_no_match: 'end_call', transfer_to: transferTo, conditions: [] } },
    });
    const version = versionRes.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'PATCH', url: `/api/v1/agents/${agent.id}`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'active' } });
    await app.inject({ method: 'POST', url: '/api/v1/vapi/credentials', headers: { authorization: `Bearer ${token}` }, payload: { api_key: 'sk-vapi-test' } });
    await app.inject({ method: 'POST', url: '/api/v1/vapi/test-connection', headers: { authorization: `Bearer ${token}` } });
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider_key: 'byon', phone_number: `+1484556${Math.floor(1000 + Math.random() * 8999)}`, capabilities: { voice_inbound: true, voice_outbound: true, sms: false }, sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' } },
    });
    const phoneNumber = importRes.json().data;

    const callRes = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_id: agent.id, phone_number_id: phoneNumber.id, customer_number: '+14845557890' },
    });
    expect(callRes.statusCode).toBe(200);
    const call = callRes.json().data;
    return { adminToken: token, call };
  }

  it('an AGENT (live_monitor.view only) is rejected on listen/whisper/barge/transfer/end; a MANAGER succeeds', async () => {
    const { adminToken, call } = await setUpOrgWithLiveCall('LM Org A', `lm-a-${Date.now()}@test.com`, '+14845559999');
    const supervisor = await inviteSupervisor(adminToken, `lm-a-sup-${Date.now()}@test.com`); // starts as AGENT

    const listenAsAgent = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/listen`, headers: { authorization: `Bearer ${supervisor.token}` } });
    expect(listenAsAgent.statusCode).toBe(403);
    const bargeAsAgent = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/barge`, headers: { authorization: `Bearer ${supervisor.token}` }, payload: {} });
    expect(bargeAsAgent.statusCode).toBe(403);
    const whisperAsAgent = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/whisper`, headers: { authorization: `Bearer ${supervisor.token}` }, payload: { text: 'hi' } });
    expect(whisperAsAgent.statusCode).toBe(403);
    const endAsAgent = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/end`, headers: { authorization: `Bearer ${supervisor.token}` } });
    expect(endAsAgent.statusCode).toBe(403);

    await setRole(adminToken, supervisor.userId, 'MANAGER');
    const listenAsManager = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/listen`, headers: { authorization: `Bearer ${supervisor.token}` } });
    expect(listenAsManager.statusCode).toBe(200);
    expect(listenAsManager.json().data.ws_url).toBe('wss://vapi.example.com/listen/abc');

    const bargeAsManager = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/barge`, headers: { authorization: `Bearer ${supervisor.token}` }, payload: {} });
    expect(bargeAsManager.statusCode).toBe(200);
    expect(bargeAsManager.json().data.mode).toBe('listen_plus_say');

    const whisperAsManager = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/whisper`, headers: { authorization: `Bearer ${supervisor.token}` }, payload: { text: 'Please confirm your appointment time.' } });
    expect(whisperAsManager.statusCode).toBe(200);
    expect(whisperAsManager.json().data.sent).toBe(true);

    // Every one of the manager's successful actions was audit logged.
    const auditActions = fake.tables.audit_logs.filter((a: any) => a.entity_id === call.id).map((a: any) => a.action);
    expect(auditActions).toContain('call.listen_started');
    expect(auditActions).toContain('call.barge_started');
    expect(auditActions).toContain('call.whisper_message_sent');
  });

  it('rejects a supervisor transfer to any destination other than the call\'s own server-resolved transfer_destination_e164 (reuses Phase 6 validation)', async () => {
    const { adminToken, call } = await setUpOrgWithLiveCall('LM Org B', `lm-b-${Date.now()}@test.com`, '+14845551111');
    const supervisor = await inviteSupervisor(adminToken, `lm-b-sup-${Date.now()}@test.com`);
    await setRole(adminToken, supervisor.userId, 'MANAGER');

    // Drive the call to 'in_progress' via a real Vapi webhook first -
    // transfer_pending is only reachable from in_progress (Phase 8's
    // state machine), exactly like the AI-initiated flow.
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });

    const wrongDestination = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${call.id}/transfer`,
      headers: { authorization: `Bearer ${supervisor.token}` },
      payload: { destination_e164: '+19995550000' },
    });
    expect(wrongDestination.statusCode).toBe(422);

    const correctDestination = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${call.id}/transfer`,
      headers: { authorization: `Bearer ${supervisor.token}` },
      payload: { destination_e164: '+14845551111' },
    });
    expect(correctDestination.statusCode).toBe(200);

    const updatedCall = fake.tables.calls.find((c: any) => c.id === call.id)!;
    expect(updatedCall.transfer_initiated_by).toBe('supervisor');
    expect(updatedCall.status).toBe('transfer_pending');

    const auditRow = fake.tables.audit_logs.find((a: any) => a.entity_id === call.id && a.action === 'call.transfer_supervisor_initiated');
    expect(auditRow).toBeTruthy();
  });

  it('refuses a transfer when the call has no transfer destination configured at all', async () => {
    const { adminToken, call } = await setUpOrgWithLiveCall('LM Org C', `lm-c-${Date.now()}@test.com`, null);
    const supervisor = await inviteSupervisor(adminToken, `lm-c-sup-${Date.now()}@test.com`);
    await setRole(adminToken, supervisor.userId, 'MANAGER');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${call.id}/transfer`,
      headers: { authorization: `Bearer ${supervisor.token}` },
      payload: { destination_e164: '+14845551111' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a call belonging to a different organization 404s for every supervisor action (org scoping)', async () => {
    const orgA = await setUpOrgWithLiveCall('LM Org D1', `lm-d1-${Date.now()}@test.com`, '+14845551111');
    const orgB = await setUpOrgWithLiveCall('LM Org D2', `lm-d2-${Date.now()}@test.com`, '+14845551111');
    const supervisorB = await inviteSupervisor(orgB.adminToken, `lm-d2-sup-${Date.now()}@test.com`);
    await setRole(orgB.adminToken, supervisorB.userId, 'MANAGER');

    // org B's manager tries to act on org A's call id.
    const listenCrossOrg = await app.inject({ method: 'POST', url: `/api/v1/calls/${orgA.call.id}/listen`, headers: { authorization: `Bearer ${supervisorB.token}` } });
    expect(listenCrossOrg.statusCode).toBe(404);
    const endCrossOrg = await app.inject({ method: 'POST', url: `/api/v1/calls/${orgA.call.id}/end`, headers: { authorization: `Bearer ${supervisorB.token}` } });
    expect(endCrossOrg.statusCode).toBe(404);
  });

  it('POST /calls/:id/end calls the provider hangup and audit logs it', async () => {
    const { adminToken, call } = await setUpOrgWithLiveCall('LM Org E', `lm-e-${Date.now()}@test.com`, '+14845551111');
    const supervisor = await inviteSupervisor(adminToken, `lm-e-sup-${Date.now()}@test.com`);
    await setRole(adminToken, supervisor.userId, 'MANAGER');

    const res = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/end`, headers: { authorization: `Bearer ${supervisor.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ended).toBe(true);
    const auditRow = fake.tables.audit_logs.find((a: any) => a.entity_id === call.id && a.action === 'call.ended_by_supervisor');
    expect(auditRow).toBeTruthy();

    // Bug fix: this used to trust the engine's own end-of-call-report
    // webhook exclusively to mark the call terminal, which left it
    // permanently stuck showing "live" in Live Monitor whenever that
    // webhook was lost or delayed - the supervisor's own explicit end
    // action is now authoritative and applies locally right away.
    const updatedCall = fake.tables.calls.find((c: any) => c.id === call.id)!;
    expect(updatedCall.status).toBe('completed');
    expect(updatedCall.ended_reason).toBe('supervisor_ended');

    // A late-arriving real webhook (or a second manual end click) is a
    // harmless no-op against an already-terminal call, never re-applied.
    const secondEnd = await app.inject({ method: 'POST', url: `/api/v1/calls/${call.id}/end`, headers: { authorization: `Bearer ${supervisor.token}` } });
    expect(secondEnd.statusCode).toBe(200);
  });
});
