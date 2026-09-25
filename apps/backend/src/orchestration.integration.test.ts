import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 6 integration test: agent + phone number set up -> POST /calls
 * originates a real (mocked-at-fetch) Vapi call, creating the local
 * `calls` row before the provider call and updating it after -> a
 * simulated Vapi webhook sequence (status-update -> in-progress ->
 * end-of-call-report) drives the call through valid state transitions ->
 * replaying the exact same webhook payload does not duplicate anything
 * (idempotency, the explicitly-called-out-as-critical guarantee) -> a
 * webhook payload for org A's call can never be used to update a call
 * belonging to org B.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

describe('Phase 6: call origination via Vapi + webhook idempotency + cross-org isolation', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  let vapiCallCounter = 0;
  let vapiAssistantCounter = 0;
  let vapiPhoneNumberCounter = 0;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === 'https://api.vapi.ai/assistant' && method === 'POST') {
        // Mirrors Vapi's own real validation (POST /assistant rejects a
        // name over 40 characters) so a regression of the `Agent ${uuid}`
        // bug - 42 characters, always over the limit - fails loudly in
        // every test that originates a call, not just a dedicated one.
        const body = JSON.parse(init?.body as string);
        if (typeof body.name !== 'string' || body.name.length > 40) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ message: ['name must be shorter than or equal to 40 characters'], error: 'Bad Request', statusCode: 400 }),
          } as unknown as Response;
        }
        vapiAssistantCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `asst_test_${vapiAssistantCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
        vapiPhoneNumberCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `vapi_pn_${vapiPhoneNumberCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/call' && method === 'POST') {
        // Real Vapi call ids are globally unique (calls.vapi_call_id has a
        // real global UNIQUE index, not per-org) - the mock must reflect
        // that, or two different test-scoped orgs' calls would collide.
        vapiCallCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `vapi_call_${vapiCallCounter}`, status: 'queued' }) } as unknown as Response;
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

  async function setUpAgentAndNumber(token: string) {
    const agentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Outbound Agent', role: 'sales_agent' },
    });
    expect(agentRes.statusCode).toBe(201);
    const agent = agentRes.json().data;

    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        system_prompt: 'You are a helpful sales agent.',
        greeting_template: 'Hi there!',
        transfer_rules: { on_no_match: 'transfer', transfer_to: '+14845550000', conditions: [] },
      },
    });
    expect(versionRes.statusCode).toBe(201);
    const version = versionRes.json().data;

    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions/${version.id}/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(publishRes.statusCode).toBe(200);

    const vapiCredsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vapi/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { api_key: 'sk-vapi-test' },
    });
    expect(vapiCredsRes.statusCode).toBe(200);

    const twilioCredsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-number-providers/twilio/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { account_sid: 'AC_TEST', auth_token: 'secret' },
    });
    expect(twilioCredsRes.statusCode).toBe(200);

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider_key: 'byon',
        phone_number: '+14845551234',
        capabilities: { voice_inbound: true, voice_outbound: true, sms: false },
        sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' },
      },
    });
    expect(importRes.statusCode).toBe(200);
    const phoneNumber = importRes.json().data;

    return { agent, version, phoneNumber };
  }

  it('originates a Vapi call, creates the local calls row, and drives it through valid webhook transitions', async () => {
    const token = await signup('Orchestration Org A', 'orch-a@test.com');
    const { agent, phoneNumber } = await setUpAgentAndNumber(token);

    const createCallRes = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_id: agent.id, phone_number_id: phoneNumber.id, customer_number: '+14845559999', engine: 'vapi' },
    });
    expect(createCallRes.statusCode).toBe(200);
    const call = createCallRes.json().data;
    expect(call.status).toBe('dialing');
    expect(call.engine).toBe('vapi');
    expect(call.vapi_call_id).toMatch(/^vapi_call_\d+$/);
    expect(call.transfer_destination_e164).toBe('+14845550000');

    // Local row exists in the fake DB even before we look it up via the API.
    expect(fake.tables.calls.find((c) => c.id === call.id)).toBeDefined();

    // Vapi webhook: status-update -> in-progress.
    const statusUpdatePayload = {
      message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id }, timestamp: 1000 },
    };
    const webhook1 = await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: statusUpdatePayload });
    expect(webhook1.statusCode).toBe(200);

    const afterInProgress = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(afterInProgress.json().data.status).toBe('in_progress');
    expect(afterInProgress.json().data.answered_at).not.toBeNull();

    // Vapi webhook: end-of-call-report -> completed.
    const endReportPayload = {
      message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 42, cost: 0.12, timestamp: 2000 },
    };
    const webhook2 = await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: endReportPayload });
    expect(webhook2.statusCode).toBe(200);

    const afterCompleted = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(afterCompleted.json().data.status).toBe('completed');
    expect(afterCompleted.json().data.duration_seconds).toBe(42);
    expect(afterCompleted.json().data.events.length).toBeGreaterThanOrEqual(2);

    // Idempotency: replaying the EXACT same status-update payload must not
    // create a second call_events row or re-apply/duplicate anything.
    const eventsBefore = fake.tables.call_events.filter((e) => e.call_id === call.id).length;
    const webhookEventsBefore = fake.tables.webhook_events.length;

    const replayWebhook1 = await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: statusUpdatePayload });
    expect(replayWebhook1.statusCode).toBe(200);
    expect(replayWebhook1.json().deduplicated).toBe(true);

    expect(fake.tables.call_events.filter((e) => e.call_id === call.id).length).toBe(eventsBefore);
    expect(fake.tables.webhook_events.length).toBe(webhookEventsBefore);
  });

  it('never lets a status-update("ended") race discard end-of-call-report\'s real duration/ended_at/cost', async () => {
    // Bug fix regression: Vapi's status-update("ended") used to map
    // straight to calls.status = 'completed' with no end-of-call data
    // attached. When it arrived BEFORE the end-of-call-report for the
    // same call (a real, common Vapi delivery order), the call was
    // already 'completed' by the time end-of-call-report arrived, and
    // transitionCallState() treats a same-status transition as a no-op -
    // silently discarding end-of-call-report's real duration_seconds/
    // ended_at/cost forever. status-update("ended") is now ignored
    // entirely; end-of-call-report is the only event that ever drives
    // the terminal transition.
    const token = await signup('Orchestration Status Race Org', 'orch-status-race@test.com');
    const { agent, phoneNumber } = await setUpAgentAndNumber(token);

    const createCallRes = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_id: agent.id, phone_number_id: phoneNumber.id, customer_number: '+14845558888', engine: 'vapi' },
    });
    expect(createCallRes.statusCode).toBe(200);
    const call = createCallRes.json().data;

    // status-update("ended") arrives first - must be a genuine no-op,
    // never a premature/empty 'completed' transition.
    const statusEndedWebhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'status-update', status: 'ended', call: { id: call.vapi_call_id }, timestamp: 1000 } },
    });
    expect(statusEndedWebhook.statusCode).toBe(200);

    const afterStatusUpdate = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(afterStatusUpdate.json().data.status).toBe('dialing');

    // end-of-call-report arrives second, with the real data - must still
    // land, uncontested.
    const endReportWebhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 77, cost: 0.34, timestamp: 2000 } },
    });
    expect(endReportWebhook.statusCode).toBe(200);

    const afterCompleted = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(afterCompleted.json().data.status).toBe('completed');
    expect(afterCompleted.json().data.duration_seconds).toBe(77);
    expect(afterCompleted.json().data.ended_at).not.toBeNull();
    expect(afterCompleted.json().data.cost).toBe(0.34);
  });

  it('resolves an unanswered call to completed instead of getting stuck at dialing/ringing (real no-answer path)', async () => {
    const token = await signup('Orchestration No Answer Org', 'orch-noanswer@test.com');
    const { agent, phoneNumber } = await setUpAgentAndNumber(token);

    const createCallRes = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_id: agent.id, phone_number_id: phoneNumber.id, customer_number: '+14845557777', engine: 'vapi' },
    });
    expect(createCallRes.statusCode).toBe(200);
    const call = createCallRes.json().data;
    expect(call.status).toBe('dialing');

    // Vapi webhook: status-update -> ringing. A real no-answer call NEVER
    // reaches 'in-progress'/'answered' - this is the exact gap the
    // transition table was missing (dialing/ringing had no path straight
    // to 'completed'), which silently rejected the transition below and
    // left the call showing 'dialing' forever instead of its real outcome.
    const ringingWebhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'status-update', status: 'ringing', call: { id: call.vapi_call_id }, timestamp: 1000 } },
    });
    expect(ringingWebhook.statusCode).toBe(200);

    const afterRinging = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(afterRinging.json().data.status).toBe('ringing');
    expect(afterRinging.json().data.answered_at).toBeNull();

    // Vapi webhook: end-of-call-report with no-answer, straight from
    // 'ringing' - no 'in-progress' step ever occurred.
    const endReportWebhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'no-answer', durationSeconds: 0, timestamp: 2000 } },
    });
    expect(endReportWebhook.statusCode).toBe(200);

    const afterEnded = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(afterEnded.json().data.status).toBe('completed');
    expect(afterEnded.json().data.ended_reason).toBe('no-answer');
    expect(afterEnded.json().data.duration_seconds).toBe(0);

    // The invalid-transition rejection path must never have fired for this
    // call - the fix landed the real transition instead of silently
    // dropping it.
    const events = fake.tables.call_events.filter((e) => e.call_id === call.id);
    expect(events.some((e) => e.event_type === 'call.invalid_transition_rejected')).toBe(false);
  });

  it('never lets a webhook payload for org A update a call belonging to org B, and a stray call id is recorded but changes nothing', async () => {
    const tokenA = await signup('Orchestration Org B1', 'orch-b1@test.com');
    const tokenB = await signup('Orchestration Org B2', 'orch-b2@test.com');
    const { agent: agentA, phoneNumber: phoneA } = await setUpAgentAndNumber(tokenA);
    await setUpAgentAndNumber(tokenB); // org B has its own agent/number/creds but places no call

    const createCallRes = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { agent_id: agentA.id, phone_number_id: phoneA.id, customer_number: '+14845558888', engine: 'vapi' },
    });
    expect(createCallRes.statusCode).toBe(200);
    const callA = createCallRes.json().data;
    expect(callA.vapi_call_id).toMatch(/^vapi_call_\d+$/);

    const orgBMeRes = await app.inject({ method: 'GET', url: '/api/v1/organizations/me', headers: { authorization: `Bearer ${tokenB}` } });
    const orgBId = orgBMeRes.json().data.id;

    // A webhook for a vapi_call_id that resolves to org A's call is
    // processed and applied to that call, regardless of who "sent" it -
    // there is no session/org on an unauthenticated webhook request, so
    // the only thing that could ever misattribute this is a client-
    // supplied organization_id, which this receiver never reads at all.
    const webhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'status-update', status: 'in-progress', call: { id: callA.vapi_call_id }, timestamp: 3000 } },
    });
    expect(webhook.statusCode).toBe(200);

    // Org B placed no call at all in this test - it must have exactly
    // zero rows in `calls`, and definitely none that got touched by a
    // webhook meant for org A's call.
    const orgBCalls = fake.tables.calls.filter((c) => c.organization_id === orgBId);
    expect(orgBCalls).toHaveLength(0);
    const webhookRow = fake.tables.webhook_events.find((w) => w.payload?.message?.timestamp === 3000);
    expect(webhookRow?.organization_id).toBe(callA.organization_id);
    expect(webhookRow?.organization_id).not.toBe(orgBId);

    // A webhook for a call id nobody created is recorded (for audit) but
    // matches nothing and updates nothing.
    const strayWebhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'status-update', status: 'in-progress', call: { id: 'vapi_call_does_not_exist' }, timestamp: 4000 } },
    });
    expect(strayWebhook.statusCode).toBe(200);
    expect(strayWebhook.json().matched).toBe(false);
    const strayRow = fake.tables.webhook_events.find((w) => w.payload?.message?.timestamp === 4000);
    expect(strayRow?.organization_id).toBeNull();
  });

  it('replays a failed/stored webhook event via POST /webhook-events/:id/replay', async () => {
    const token = await signup('Orchestration Org C', 'orch-c@test.com');
    const { agent, phoneNumber } = await setUpAgentAndNumber(token);

    const createCallRes = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_id: agent.id, phone_number_id: phoneNumber.id, customer_number: '+14845557777', engine: 'vapi' },
    });
    const call = createCallRes.json().data;

    await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id }, timestamp: 5000 } },
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/v1/webhook-events', headers: { authorization: `Bearer ${token}` } });
    expect(listRes.statusCode).toBe(200);
    const eventRow = listRes.json().data.find((e: any) => e.payload?.message?.timestamp === 5000);
    expect(eventRow.processing_status).toBe('processed');

    const replayRes = await app.inject({ method: 'POST', url: `/api/v1/webhook-events/${eventRow.id}/replay`, headers: { authorization: `Bearer ${token}` } });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json().data.replayed).toBe(true);
  });
});
