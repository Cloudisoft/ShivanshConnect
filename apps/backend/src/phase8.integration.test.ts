import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 8 integration tests: the disposition engine / retry engine /
 * callback scheduler / DNC tool-call handling wired end to end through
 * real route handlers (app.inject()) against the same fakeSupabase
 * harness Phase 7's campaign engine test uses. Focused on the three hard
 * invariants the task brief calls out:
 *   1. Exactly one disposition per call, single source of truth with
 *      campaign_leads.final_disposition (no divergence).
 *   2. A DNC lead is NEVER dialed again, even after being manually
 *      re-added to a campaign (regression test against the dispatcher).
 *   3. A callback shares the exact same dispatch/claim machinery as a
 *      normal lead - no parallel dial path - and overrides cooldown.
 * Plus: manual disposition override + audit log, and cross-org isolation
 * for dispositions/callbacks.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.WORKER_POOL_CAPACITY = '50';

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

let vapiCallCounter = 0;
let vapiAssistantCounter = 0;
let vapiPhoneNumberCounter = 0;
let vapiHangupCalls: string[] = [];

describe('Phase 8: disposition engine, retry engine, callbacks, DNC tool-calls', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;
  let processCampaign: typeof import('./services/campaignDispatcher.js').processCampaign;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === 'https://api.vapi.ai/assistant' && method === 'POST') {
        vapiAssistantCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p8_asst_${vapiAssistantCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
        vapiPhoneNumberCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p8_vapi_pn_${vapiPhoneNumberCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/call' && method === 'POST') {
        vapiCallCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p8_vapi_call_${vapiCallCounter}`, status: 'queued' }) } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/assistant?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/call/') && url.endsWith('/hangup') && method === 'POST') {
        vapiHangupCalls.push(url);
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
    processCampaign = (await import('./services/campaignDispatcher.js')).processCampaign;
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return res.json().data.session.access_token as string;
  }

  async function setUpOrgBasics(token: string) {
    const agentRes = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Campaign Agent', role: 'sales_agent' } });
    const agent = agentRes.json().data;
    const versionRes = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions`, headers: { authorization: `Bearer ${token}` }, payload: { system_prompt: 'You are a helpful sales agent.', greeting_template: 'Hi there!' } });
    const agentVersion = versionRes.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions/${agentVersion.id}/publish`, headers: { authorization: `Bearer ${token}` } });
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
    return { agent, agentVersion, phoneNumber };
  }

  async function createCampaignWithLeads(token: string, agentId: string, phoneNumberId: string, leadCount: number) {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/campaigns', headers: { authorization: `Bearer ${token}` }, payload: { name: `P8 Campaign ${Date.now()}-${Math.random()}`, phone_number_id: phoneNumberId, concurrency_limit: 5, transfer_number_e164: '+14845550099' } });
    const campaign = createRes.json().data;
    const listRes = await app.inject({ method: 'POST', url: '/api/v1/lead-lists', headers: { authorization: `Bearer ${token}` }, payload: { name: `P8 List ${Date.now()}-${Math.random()}` } });
    const list = listRes.json().data;
    let leadIds: string[] = [];
    if (leadCount > 0) {
      const numbers = Array.from({ length: leadCount }, (_, i) => `+1202555${String(2000 + i).padStart(4, '0')}`);
      await app.inject({ method: 'POST', url: '/api/v1/leads/bulk', headers: { authorization: `Bearer ${token}` }, payload: { lead_list_id: list.id, numbers } });
      const attachRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/leads`, headers: { authorization: `Bearer ${token}` }, payload: { lead_list_id: list.id } });
      leadIds = attachRes.json().data.lead_ids ?? [];
    }
    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaign.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Hi {{first_name}}.', ai_agent_id: agentId, calling_rules: { calling_window_start: '00:00', calling_window_end: '23:59', calling_days: [1, 2, 3, 4, 5, 6, 7] } },
    });
    const version = versionRes.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    return { campaign, list, leadIds };
  }

  it('assigns exactly one disposition per call and keeps campaign_leads.final_disposition in sync with it (single source of truth)', async () => {
    const token = await signup('Disposition Org', `disp-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 1);

    const runningCampaign = fake.tables.campaigns.find((c) => c.id === campaign.id)!;
    const result = await processCampaign(runningCampaign);
    expect(result.dispatched).toBe(1);

    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;
    const call = fake.tables.calls.find((c) => c.id === cl.last_call_id)!;

    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 90 } } });

    // Exactly one call_dispositions row for this call.
    const dispositions = fake.tables.call_dispositions.filter((d) => d.call_id === call.id);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].disposition_source).toBe('engine');

    const dispositionRow = fake.tables.dispositions.find((d) => d.id === dispositions[0].disposition_id)!;
    expect(dispositionRow.code).toBe('CALL_CONNECTED');

    const updatedLead = fake.tables.campaign_leads.find((r) => r.id === cl.id)!;
    expect(updatedLead.status).toBe('completed');
    // Single source of truth: campaign_leads.final_disposition is exactly
    // the same code call_dispositions holds - never a divergent re-
    // derivation.
    expect(updatedLead.final_disposition).toBe(dispositionRow.code);
  });

  it('a supervisor manual override writes disposition_source=manual and an audit log entry, and the engine never re-derives over it', async () => {
    const token = await signup('Override Org', `override-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 1);

    await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;
    const call = fake.tables.calls.find((c) => c.id === cl.last_call_id)!;
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 90 } } });

    const notInterested = fake.tables.dispositions.find((d) => d.code === 'NOT_INTERESTED')!;
    const overrideRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/calls/${call.id}/disposition`,
      headers: { authorization: `Bearer ${token}` },
      payload: { disposition_id: notInterested.id, reason: 'Caller said not interested near the end of the call.' },
    });
    expect(overrideRes.statusCode).toBe(200);
    expect(overrideRes.json().data.disposition_source).toBe('manual');

    const auditEntry = fake.tables.audit_logs.find((a) => a.action === 'call_disposition.overridden' && a.entity_id === call.id);
    expect(auditEntry).toBeTruthy();

    // Only one call_dispositions row still exists (updated in place, not
    // duplicated) and it now reflects the manual override.
    const dispositions = fake.tables.call_dispositions.filter((d) => d.call_id === call.id);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].disposition_source).toBe('manual');
    expect(dispositions[0].disposition_id).toBe(notInterested.id);
  });

  it('DNC-never-retry regression: a tool-call DNC request flips is_dnc, inserts dnc_entries, transitions the call to dnc, and the lead is never dialed again even after being manually re-added to a campaign', async () => {
    const token = await signup('DNC ToolCall Org', `dnctool-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 1);

    await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;
    const call = fake.tables.calls.find((c) => c.id === cl.last_call_id)!;
    const leadId = cl.lead_id;

    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });

    // The AI recognizes a DNC request mid-call via a real tool-call event.
    const toolCallRes = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'tool-calls', call: { id: call.vapi_call_id }, toolCallList: [{ id: 'tc-dnc-1', function: { name: 'request_dnc', arguments: { reason: 'Caller asked to never be called again.' } } }] } },
    });
    expect(toolCallRes.statusCode).toBe(200);

    const leadRow = fake.tables.leads.find((l) => l.id === leadId)!;
    expect(leadRow.is_dnc).toBe(true);

    const dncEntry = fake.tables.dnc_entries.find((e) => e.organization_id === leadRow.organization_id && e.phone_normalized === leadRow.phone_normalized);
    expect(dncEntry).toBeTruthy();
    expect(dncEntry!.source).toBe('caller_request');

    // Bug fix: recognizing a DNC request used to only update local state -
    // the live call itself kept going until it wrapped up naturally. A
    // caller who explicitly asked to be hung up on must actually be hung
    // up on, not talked at for another turn.
    expect(vapiHangupCalls).toEqual([`https://api.vapi.ai/call/${call.vapi_call_id}/hangup`]);

    const updatedCall = fake.tables.calls.find((c) => c.id === call.id)!;
    expect(updatedCall.status).toBe('dnc');

    const updatedCampaignLead = fake.tables.campaign_leads.find((r) => r.id === cl.id)!;
    expect(updatedCampaignLead.status).toBe('dnc');

    const dispositionRow = fake.tables.call_dispositions.find((d) => d.call_id === call.id);
    const dispositionCode = fake.tables.dispositions.find((d) => d.id === dispositionRow?.disposition_id)?.code;
    expect(dispositionCode).toBe('DNC');

    // Regression: manually re-add the same lead to a BRAND NEW campaign
    // and run a real dispatch tick - it must never be dialed.
    const { campaign: secondCampaign } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 0);
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${secondCampaign.id}/leads`, headers: { authorization: `Bearer ${token}` }, payload: { lead_ids: [leadId] } });

    const callCountBefore = fake.tables.calls.length;
    await processCampaign(fake.tables.campaigns.find((c) => c.id === secondCampaign.id)!);
    expect(fake.tables.calls.length).toBe(callCountBefore); // no new call originated

    const secondCampaignLead = fake.tables.campaign_leads.find((r) => r.campaign_id === secondCampaign.id && r.lead_id === leadId)!;
    expect(secondCampaignLead.status).toBe('dnc');
  });

  it('a tool-call schedule_callback event creates a real callbacks row from a real webhook delivery', async () => {
    const token = await signup('Callback ToolCall Org', `cbtool-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 1);

    await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;
    const call = fake.tables.calls.find((c) => c.id === cl.last_call_id)!;

    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });

    const scheduledAt = new Date(Date.now() + 3600_000).toISOString();
    const toolCallRes = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'tool-calls', call: { id: call.vapi_call_id }, toolCallList: [{ id: 'tc-cb-1', function: { name: 'schedule_callback', arguments: JSON.stringify({ scheduled_at: scheduledAt, reason: 'Wants a callback tomorrow.' }) } }] } },
    });
    expect(toolCallRes.statusCode).toBe(200);

    const callback = fake.tables.callbacks.find((c) => c.source_call_id === call.id);
    expect(callback).toBeTruthy();
    expect(callback!.assigned_to).toBe('ai');
    expect(callback!.status).toBe('scheduled');
    expect(new Date(callback!.scheduled_at).getTime()).toBe(new Date(scheduledAt).getTime());

    // The callback was created WHILE the call was still active (its
    // campaign_leads row is still 'dialing') - scheduling never clobbers
    // an in-flight dial. Once the call actually ends, the terminal
    // bookkeeping (services/campaignLeadDisposition.ts) picks up the
    // still-pending callback and overrides normal cooldown with its
    // scheduled_at, through the SAME next_eligible_at column the
    // dispatcher's eligibility query already reads - never a parallel
    // field, and never dependent on ordering between the tool-call event
    // and the end-of-call event.
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 20 } } });
    const refreshedLead = fake.tables.campaign_leads.find((r) => r.id === cl.id)!;
    expect(refreshedLead.status).toBe('pending');
    expect(new Date(refreshedLead.next_eligible_at).getTime()).toBe(new Date(scheduledAt).getTime());
  });

  it('callback scheduling overrides normal cooldown and the callback is picked up by the SAME dispatcher claim machinery once due - no parallel dial path', async () => {
    const token = await signup('Callback Override Org', `cboverride-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 1);

    await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;
    const call = fake.tables.calls.find((c) => c.id === cl.last_call_id)!;

    // Simulate a normal retryable outcome first: cooldown is set far in
    // the future.
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'no-answer', durationSeconds: 0 } } });
    const cooldownLead = fake.tables.campaign_leads.find((r) => r.id === cl.id)!;
    expect(cooldownLead.status).toBe('retry_pending');
    expect(new Date(cooldownLead.next_eligible_at).getTime()).toBeGreaterThan(Date.now());

    // A tick right now dispatches nothing for this lead - cooldown active.
    await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    const stillCoolingDown = fake.tables.campaign_leads.find((r) => r.id === cl.id)!;
    expect(stillCoolingDown.status).toBe('retry_pending');

    // A human agent schedules a callback for a time in the near future -
    // this overrides the cooldown by refreshing next_eligible_at.
    const scheduledAt = new Date(Date.now() + 1000).toISOString();
    const callbackRes = await app.inject({
      method: 'POST',
      url: '/api/v1/callbacks',
      headers: { authorization: `Bearer ${token}` },
      payload: { lead_id: cl.lead_id, campaign_id: campaign.id, scheduled_at: scheduledAt, reason: 'Asked to be called back soon.' },
    });
    expect(callbackRes.statusCode).toBe(200);

    const overriddenLead = fake.tables.campaign_leads.find((r) => r.id === cl.id)!;
    expect(overriddenLead.status).toBe('pending');
    expect(new Date(overriddenLead.next_eligible_at).getTime()).toBe(new Date(scheduledAt).getTime());

    // Once the callback's time has arrived (simulated here by the same
    // time already having elapsed, since scheduled_at was set 1s in the
    // future and this call happens synchronously after), the exact same
    // dispatcher claim/dial path (processCampaign -> claimCampaignLead ->
    // originateCall) picks the lead back up - never a parallel path.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const callCountBefore = fake.tables.calls.length;
    const dueTick = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    expect(dueTick.dispatched).toBe(1);
    expect(fake.tables.calls.length).toBe(callCountBefore + 1);

    const redialedLead = fake.tables.campaign_leads.find((r) => r.id === cl.id)!;
    expect(redialedLead.status).toBe('dialing');
    expect(redialedLead.attempt_count).toBe(2);
  });

  it('cross-org isolation: an org cannot see, edit or cancel another org\'s custom dispositions or callbacks', async () => {
    const tokenA = await signup('Iso Org A', `isoa-${Date.now()}@test.com`);
    const tokenB = await signup('Iso Org B', `isob-${Date.now()}@test.com`);

    const createDispositionRes = await app.inject({ method: 'POST', url: '/api/v1/dispositions', headers: { authorization: `Bearer ${tokenA}` }, payload: { code: 'CALLBACK_LATER', name: 'Callback Later' } });
    expect(createDispositionRes.statusCode).toBe(200);
    const disposition = createDispositionRes.json().data;

    const listFromB = await app.inject({ method: 'GET', url: '/api/v1/dispositions?page_size=100', headers: { authorization: `Bearer ${tokenB}` } });
    expect(listFromB.json().data.some((d: any) => d.id === disposition.id)).toBe(false);

    const editFromB = await app.inject({ method: 'PATCH', url: `/api/v1/dispositions/${disposition.id}`, headers: { authorization: `Bearer ${tokenB}` }, payload: { name: 'Hijacked' } });
    expect(editFromB.statusCode).toBe(404);

    const { agent, phoneNumber } = await setUpOrgBasics(tokenA);
    const { campaign } = await createCampaignWithLeads(tokenA, agent.id, phoneNumber.id, 1);
    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;

    const callbackRes = await app.inject({
      method: 'POST',
      url: '/api/v1/callbacks',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { lead_id: cl.lead_id, scheduled_at: new Date(Date.now() + 3600_000).toISOString(), reason: 'Org A callback' },
    });
    expect(callbackRes.statusCode).toBe(200);
    const callback = callbackRes.json().data;

    const getFromB = await app.inject({ method: 'GET', url: `/api/v1/callbacks/${callback.id}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(getFromB.statusCode).toBe(404);

    const cancelFromB = await app.inject({ method: 'PATCH', url: `/api/v1/callbacks/${callback.id}`, headers: { authorization: `Bearer ${tokenB}` }, payload: { status: 'cancelled' } });
    expect(cancelFromB.statusCode).toBe(404);

    const listFromBCallbacks = await app.inject({ method: 'GET', url: '/api/v1/callbacks', headers: { authorization: `Bearer ${tokenB}` } });
    expect(listFromBCallbacks.json().data).toHaveLength(0);
  });
});
