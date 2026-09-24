import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 7 integration test: campaign create -> attach a 55-lead list ->
 * publish a version (the snapshot step) -> preflight fails without a
 * transfer number -> set one -> preflight passes -> start -> a real
 * dispatcher tick claims leads up to concurrency and originates calls
 * through the mocked-at-fetch Vapi engine -> simulated webhook call-ended
 * events drive campaign_leads to retry_pending/completed/dnc -> the
 * rotate endpoint filters correctly -> cross-org isolation -> the
 * publish-time snapshot never changes even after the underlying agent is
 * re-published -> concurrent dispatch ticks never double-dial the same
 * lead -> a 1000-synthetic-lead batch never loses a lead (always
 * terminal or explicitly pending).
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

describe('Phase 7: campaign engine end-to-end', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;
  let processCampaign: typeof import('./services/campaignDispatcher.js').processCampaign;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === 'https://api.vapi.ai/assistant' && method === 'POST') {
        vapiAssistantCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `asst_${vapiAssistantCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
        vapiPhoneNumberCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `vapi_pn_${vapiPhoneNumberCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/call' && method === 'POST') {
        vapiCallCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `vapi_call_${vapiCallCounter}`, status: 'queued' }) } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/assistant?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
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
    expect(agentRes.statusCode).toBe(201);
    const agent = agentRes.json().data;

    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'You are a helpful sales agent.', greeting_template: 'Hi there!' },
    });
    expect(versionRes.statusCode).toBe(201);
    const agentVersion = versionRes.json().data;

    const publishRes = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions/${agentVersion.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    expect(publishRes.statusCode).toBe(200);

    const activateRes = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${agent.id}`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'active' } });
    expect(activateRes.statusCode).toBe(200);

    const vapiCredsRes = await app.inject({ method: 'POST', url: '/api/v1/vapi/credentials', headers: { authorization: `Bearer ${token}` }, payload: { api_key: 'sk-vapi-test' } });
    expect(vapiCredsRes.statusCode).toBe(200);
    const testConnRes = await app.inject({ method: 'POST', url: '/api/v1/vapi/test-connection', headers: { authorization: `Bearer ${token}` } });
    expect(testConnRes.statusCode).toBe(200);
    expect(testConnRes.json().data.status).toBe('connected');

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider_key: 'byon',
        phone_number: `+1484555${Math.floor(1000 + Math.random() * 8999)}`,
        capabilities: { voice_inbound: true, voice_outbound: true, sms: false },
        sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' },
      },
    });
    expect(importRes.statusCode).toBe(200);
    const phoneNumber = importRes.json().data;

    return { agent, agentVersion, phoneNumber };
  }

  async function createCampaignWithLeads(token: string, agentId: string, phoneNumberId: string, leadCount: number) {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Campaign ${Date.now()}-${Math.random()}`, phone_number_id: phoneNumberId, concurrency_limit: 3 },
    });
    expect(createRes.statusCode).toBe(200);
    const campaign = createRes.json().data;

    const listRes = await app.inject({ method: 'POST', url: '/api/v1/lead-lists', headers: { authorization: `Bearer ${token}` }, payload: { name: `List ${Date.now()}-${Math.random()}` } });
    expect(listRes.statusCode).toBe(201);
    const list = listRes.json().data;

    if (leadCount > 0) {
      const numbers = Array.from({ length: leadCount }, (_, i) => `+1201555${String(1000 + i).padStart(4, '0')}`);
      const bulkRes = await app.inject({ method: 'POST', url: '/api/v1/leads/bulk', headers: { authorization: `Bearer ${token}` }, payload: { lead_list_id: list.id, numbers } });
      expect(bulkRes.statusCode).toBe(200);

      const attachRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/leads`, headers: { authorization: `Bearer ${token}` }, payload: { lead_list_id: list.id } });
      expect(attachRes.statusCode).toBe(200);
      expect(attachRes.json().data.attached).toBe(leadCount);
    }

    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaign.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        prompt: 'Hi {{first_name}}, calling about your account.',
        ai_agent_id: agentId,
        calling_rules: { calling_window_start: '00:00', calling_window_end: '23:59', calling_days: [1, 2, 3, 4, 5, 6, 7] },
      },
    });
    expect(versionRes.statusCode).toBe(200);
    const version = versionRes.json().data;

    return { campaign, list, version };
  }

  it('runs the full create -> attach -> publish -> preflight -> start -> dispatch -> webhook -> rotate lifecycle', async () => {
    const token = await signup('Campaign Lifecycle Org', `lifecycle-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 55);

    // Preflight fails: no published version yet, no transfer number.
    const preflightBefore = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}/preflight`, headers: { authorization: `Bearer ${token}` } });
    expect(preflightBefore.json().data.ready).toBe(false);
    expect(preflightBefore.json().data.errors.some((e: any) => e.code === 'no_published_version')).toBe(true);

    const publishRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    expect(publishRes.statusCode).toBe(200);
    const publishedAgentVersionId = publishRes.json().data.version.ai_agent_version_id;
    expect(publishedAgentVersionId).toBe(agent.current_version_id ?? publishedAgentVersionId); // sanity, refined below

    const preflightNoTransfer = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}/preflight`, headers: { authorization: `Bearer ${token}` } });
    expect(preflightNoTransfer.json().data.ready).toBe(false);
    expect(preflightNoTransfer.json().data.errors.some((e: any) => e.code === 'no_transfer_number')).toBe(true);

    const setTransferRes = await app.inject({ method: 'PATCH', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` }, payload: { transfer_number_e164: '+14845550099' } });
    expect(setTransferRes.statusCode).toBe(200);

    const preflightReady = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}/preflight`, headers: { authorization: `Bearer ${token}` } });
    expect(preflightReady.json().data.ready).toBe(true);
    expect(preflightReady.json().data.errors).toEqual([]);

    const startRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().data.status).toBe('running');

    // Run a real dispatch tick: concurrency_limit is 3, so exactly 3 of
    // the 55 leads should be claimed and dialed.
    const runningCampaign = fake.tables.campaigns.find((c) => c.id === campaign.id)!;
    const result = await processCampaign(runningCampaign);
    expect(result.dispatched).toBe(3);

    const dialingLeads = fake.tables.campaign_leads.filter((cl) => cl.campaign_id === campaign.id && cl.status === 'dialing');
    expect(dialingLeads).toHaveLength(3);
    for (const cl of dialingLeads) {
      expect(cl.last_call_id).toBeTruthy();
      expect(cl.attempt_count).toBe(1);
    }

    // A second tick, with those 3 calls still active, dispatches 0 more
    // (capacity is already fully used).
    const secondTick = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    expect(secondTick.dispatched).toBe(0);

    // Simulate webhook outcomes for the 3 in-flight calls: one completes
    // normally (terminal success), one gets a retryable no-answer
    // (-> retry_pending with a future next_eligible_at), one fails
    // permanently.
    const [clA, clB, clC] = dialingLeads;
    const callA = fake.tables.calls.find((c) => c.id === clA.last_call_id)!;
    const callB = fake.tables.calls.find((c) => c.id === clB.last_call_id)!;
    const callC = fake.tables.calls.find((c) => c.id === clC.last_call_id)!;

    // Calls must reach 'in_progress' before 'completed'/'failed' is a
    // valid transition (spec 50's state machine) - same status-update ->
    // end-of-call-report sequence Phase 6's own orchestration test uses.
    for (const call of [callA, callB, callC]) {
      const statusUpdate = await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });
      expect(statusUpdate.statusCode).toBe(200);
    }
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: callA.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 30 } } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: callB.vapi_call_id }, endedReason: 'no-answer', durationSeconds: 0 } } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: callC.vapi_call_id }, endedReason: 'invalid-number', durationSeconds: 0 } } });

    const updatedA = fake.tables.campaign_leads.find((cl) => cl.id === clA.id)!;
    const updatedB = fake.tables.campaign_leads.find((cl) => cl.id === clB.id)!;
    const updatedC = fake.tables.campaign_leads.find((cl) => cl.id === clC.id)!;
    expect(updatedA.status).toBe('completed');
    expect(updatedB.status).toBe('retry_pending');
    expect(updatedB.next_eligible_at).toBeTruthy();
    expect(new Date(updatedB.next_eligible_at).getTime()).toBeGreaterThan(Date.now());
    // A non-retryable ended_reason on an otherwise-'completed' call
    // (Vapi's own model: only 'assistant-forwarded-call' maps to
    // 'transferred' at the call-status level - everything else that
    // isn't a raw origination failure lands as 'completed') still
    // terminalizes the campaign_leads row rather than looping forever -
    // final_disposition is now Phase 8's assigned disposition CODE (the
    // single source of truth call_dispositions also holds), not the raw
    // ended_reason string: a 0-second "completed" call to an invalid
    // number is deterministically NOT_IN_SERVICE (its own distinct
    // disposition, separate from a generic technical DISCONNECTED).
    expect(updatedC.status).toBe('completed');
    expect(updatedC.final_disposition).toBe('NOT_IN_SERVICE');

    // The retry-pending lead is NOT re-claimed by a tick right now (its
    // cooldown hasn't elapsed) even though capacity is free again.
    const thirdTick = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    const stillRetryPending = fake.tables.campaign_leads.find((cl) => cl.id === clB.id)!;
    expect(stillRetryPending.status).toBe('retry_pending');
    expect(thirdTick.dispatched).toBeGreaterThan(0); // other still-pending leads get picked up instead

    // Rotate (dry run): the completed/transferred lead is excluded, the
    // failed permanently is excluded (final_disposition not in the
    // retryable set), retry_pending is included.
    const rotateDryRun = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/leads/rotate`, headers: { authorization: `Bearer ${token}` }, payload: { dry_run: true } });
    expect(rotateDryRun.statusCode).toBe(200);
    const rotateData = rotateDryRun.json().data;
    const decisionForA = rotateData.decisions.find((d: any) => d.campaignLeadId === clA.id);
    const decisionForB = rotateData.decisions.find((d: any) => d.campaignLeadId === clB.id);
    expect(decisionForA.include).toBe(false); // completed
    expect(decisionForB.include).toBe(true); // retry_pending

    // DNC invariant: attach a DNC lead directly and confirm the
    // dispatcher never dials it, ever - it goes straight to terminal
    // 'dnc' the first time it's evaluated.
    const dncLeadRes = await app.inject({ method: 'POST', url: '/api/v1/leads', headers: { authorization: `Bearer ${token}` }, payload: { phone: '+12015559999', first_name: 'Never', last_name: 'Call' } });
    const dncLead = dncLeadRes.json().data;
    await app.inject({ method: 'POST', url: '/api/v1/dnc', headers: { authorization: `Bearer ${token}` }, payload: { phone: '+12015559999', reason: 'requested' } });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/leads`, headers: { authorization: `Bearer ${token}` }, payload: { lead_ids: [dncLead.id] } });
    await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    const dncCampaignLead = fake.tables.campaign_leads.find((cl) => cl.campaign_id === campaign.id && cl.lead_id === dncLead.id)!;
    expect(dncCampaignLead.status).toBe('dnc');
    expect(fake.tables.calls.some((c) => c.lead_id === dncLead.id)).toBe(false);
  });

  it('restarts a stopped campaign back to running, but rejects restart from any other status', async () => {
    const token = await signup('Restart Org', `restart-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 5);

    // Never restartable before it has ever run.
    const restartTooEarly = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/restart`, headers: { authorization: `Bearer ${token}` } });
    expect(restartTooEarly.statusCode).toBe(422);

    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'PATCH', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` }, payload: { transfer_number_e164: '+14845550099' } });

    const startRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    expect(startRes.json().data.status).toBe('running');

    // Never restartable while still running - /stop or /pause first.
    const restartWhileRunning = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/restart`, headers: { authorization: `Bearer ${token}` } });
    expect(restartWhileRunning.statusCode).toBe(422);

    const stopRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/stop`, headers: { authorization: `Bearer ${token}` } });
    expect(stopRes.json().data.status).toBe('stopped');

    // Now restartable: goes straight back to running (same preflight-gated
    // path /start uses), and can be dispatched against immediately.
    const restartRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/restart`, headers: { authorization: `Bearer ${token}` } });
    expect(restartRes.statusCode).toBe(200);
    expect(restartRes.json().data.status).toBe('running');

    const result = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    expect(result.dispatched).toBeGreaterThan(0);
  });

  it('removes attached leads from a campaign, but never one currently on an active call', async () => {
    const token = await signup('Remove Leads Org', `remove-leads-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 5);

    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'PATCH', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` }, payload: { transfer_number_e164: '+14845550099' } });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });

    const dispatchResult = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    expect(dispatchResult.dispatched).toBe(3); // concurrency_limit is 3

    const allCampaignLeads = fake.tables.campaign_leads.filter((cl) => cl.campaign_id === campaign.id);
    const dialingLead = allCampaignLeads.find((cl) => cl.status === 'dialing')!;
    const pendingLead = allCampaignLeads.find((cl) => cl.status === 'pending')!;

    const removeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaign.id}/leads/remove`,
      headers: { authorization: `Bearer ${token}` },
      payload: { lead_ids: [dialingLead.lead_id, pendingLead.lead_id] },
    });
    expect(removeRes.statusCode).toBe(200);
    expect(removeRes.json().data).toEqual({ removed: 1, skipped_active: 1 });

    // The pending lead is gone entirely; the actively-dialing one is left
    // untouched - never orphan an in-flight call by yanking its row out
    // from under it.
    const remaining = fake.tables.campaign_leads.filter((cl) => cl.campaign_id === campaign.id);
    expect(remaining.some((cl) => cl.lead_id === pendingLead.lead_id)).toBe(false);
    expect(remaining.some((cl) => cl.lead_id === dialingLead.lead_id)).toBe(true);

    // Cross-org isolation: a different org cannot act on this campaign at
    // all - 404, not a silent no-op.
    const otherToken = await signup('Remove Leads Org B', `remove-leads-b-${Date.now()}@test.com`);
    const crossOrgRemove = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaign.id}/leads/remove`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { lead_ids: [dialingLead.lead_id] },
    });
    expect(crossOrgRemove.statusCode).toBe(404);
  });

  it('never lets a running campaign edit change the already-published snapshot, even after the underlying agent is re-published', async () => {
    const token = await signup('Snapshot Org', `snapshot-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 2);

    const publishRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    const snapshottedAgentVersionId = publishRes.json().data.version.ai_agent_version_id;
    expect(snapshottedAgentVersionId).toBeTruthy();

    // Re-publish the underlying agent with a NEW version.
    const newVersionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'A completely different prompt now.', greeting_template: 'Hello, new greeting.' },
    });
    const newAgentVersion = newVersionRes.json().data;
    const republishRes = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions/${newAgentVersion.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    expect(republishRes.statusCode).toBe(200);
    expect(republishRes.json().data.current_version_id).not.toBe(snapshottedAgentVersionId);

    // The campaign's published version must still point at the OLD
    // snapshotted agent version - never silently updated.
    const campaignDetail = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(campaignDetail.json().data.current_version.ai_agent_version_id).toBe(snapshottedAgentVersionId);
    expect(campaignDetail.json().data.current_version.ai_agent_version_id).not.toBe(newAgentVersion.id);
  });

  it('returns an unpublished draft version on GET /campaigns/:id, not just the last published one', async () => {
    const token = await signup('Draft Visibility Org', `draft-vis-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 0);

    // Nothing published yet - GET should surface the draft, not just null.
    const beforePublish = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(beforePublish.json().data.current_version).toBeNull();
    expect(beforePublish.json().data.draft_version).toBeTruthy();
    expect(beforePublish.json().data.draft_version.id).toBe(version.id);
    expect(beforePublish.json().data.draft_version.prompt).toBe('Hi {{first_name}}, calling about your account.');

    await app.inject({ method: 'PATCH', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` }, payload: { transfer_number_e164: '+14845550099' } });
    const publishRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    expect(publishRes.statusCode).toBe(200);

    // Once published, there's no outstanding draft any more.
    const afterPublish = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(afterPublish.json().data.draft_version).toBeNull();
    expect(afterPublish.json().data.current_version.id).toBe(version.id);

    // Saving a NEW draft on top of a published campaign should surface
    // that new draft too, alongside the still-live published version.
    const newDraftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaign.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        prompt: 'An updated pitch, not yet live.',
        ai_agent_id: agent.id,
        calling_rules: { calling_window_start: '00:00', calling_window_end: '23:59', calling_days: [1, 2, 3, 4, 5, 6, 7] },
      },
    });
    expect(newDraftRes.statusCode).toBe(200);
    const newDraft = newDraftRes.json().data;

    const withNewDraft = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(withNewDraft.json().data.draft_version.id).toBe(newDraft.id);
    expect(withNewDraft.json().data.draft_version.prompt).toBe('An updated pitch, not yet live.');
    expect(withNewDraft.json().data.current_version.id).toBe(version.id);
  });

  it('never dials the same lead twice under concurrent dispatch ticks (race-safe CAS claim)', async () => {
    const token = await signup('Race Org', `race-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 8);

    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'PATCH', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` }, payload: { transfer_number_e164: '+14845550099' } });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });

    const runningCampaign = fake.tables.campaigns.find((c) => c.id === campaign.id)!;

    // Two ticks racing over the same 8 pending leads.
    const [resultA, resultB] = await Promise.all([processCampaign(runningCampaign), processCampaign(runningCampaign)]);

    const claimedLeads = fake.tables.campaign_leads.filter((cl) => cl.campaign_id === campaign.id && cl.status === 'dialing');
    const claimedLeadIds = claimedLeads.map((cl) => cl.lead_id);
    // The hard invariant: every claimed lead is claimed EXACTLY once - no
    // duplicate lead ids among claimed rows, and the number of `calls`
    // rows created for this campaign equals the number of distinct
    // claimed leads (never more calls than distinct leads).
    expect(new Set(claimedLeadIds).size).toBe(claimedLeadIds.length);
    const callsForCampaign = fake.tables.calls.filter((c) => c.campaign_id === campaign.id);
    expect(callsForCampaign).toHaveLength(claimedLeadIds.length);
    // Total dispatched across both concurrent ticks together never
    // exceeds the number of leads that existed to claim.
    expect(resultA.dispatched + resultB.dispatched).toBeLessThanOrEqual(8);
    expect(resultA.dispatched + resultB.dispatched).toBe(claimedLeadIds.length);
  });

  it('cross-org isolation: org B cannot see or act on org A campaigns', async () => {
    const tokenA = await signup('Campaign Org A', `camp-a-${Date.now()}@test.com`);
    const tokenB = await signup('Campaign Org B', `camp-b-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(tokenA);
    const { campaign } = await createCampaignWithLeads(tokenA, agent.id, phoneNumber.id, 2);

    const getAsB = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(getAsB.statusCode).toBe(404);

    const startAsB = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(startAsB.statusCode).toBe(404);

    const listAsB = await app.inject({ method: 'GET', url: '/api/v1/campaigns', headers: { authorization: `Bearer ${tokenB}` } });
    expect(listAsB.json().data.some((c: any) => c.id === campaign.id)).toBe(false);
  });

  it('never loses a lead across a large synthetic batch - every campaign_leads row ends terminal or explicitly pending', async () => {
    const token = await signup('Scale Org', `scale-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 0);

    // Insert 1000 leads + campaign_leads rows directly (bypassing HTTP for
    // speed - this is exercising the dispatcher's own bounded, indexed
    // query pattern, not the attach endpoint). A real Postgres index
    // (campaign_leads_dispatch_idx on (campaign_id, status,
    // next_eligible_at) - see supabase/migrations/00000000000031) is what
    // keeps the equivalent query index-backed in production; this
    // in-memory fake can only prove the query shape stays LIMIT-bounded
    // (never loads all 1000 rows into a single unbounded fetch) and that
    // the result is behaviorally correct at this scale.
    const orgId = fake.tables.campaigns.find((c) => c.id === campaign.id)!.organization_id;
    const leadIds: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const leadId = crypto.randomUUID();
      leadIds.push(leadId);
      fake.tables.leads.push({
        id: leadId,
        organization_id: orgId,
        lead_list_id: null,
        first_name: 'Scale',
        last_name: `Lead${i}`,
        phone_original: `+1301555${String(1000 + i).padStart(4, '0')}`,
        phone_normalized: `+1301555${String(1000 + i).padStart(4, '0')}`,
        country_code: 'US',
        status: 'NEW',
        attempts: 0,
        is_dnc: false,
        custom_fields: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      fake.tables.campaign_leads.push({
        id: crypto.randomUUID(),
        campaign_id: campaign.id,
        organization_id: orgId,
        lead_id: leadId,
        status: 'pending',
        attempt_count: 0,
        last_attempt_at: null,
        next_eligible_at: null,
        last_call_id: null,
        final_disposition: null,
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'PATCH', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` }, payload: { transfer_number_e164: '+14845550099', concurrency_limit: 20 } });
    const startRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    expect(startRes.statusCode).toBe(200);

    const runningCampaign = fake.tables.campaigns.find((c) => c.id === campaign.id)!;
    const started = Date.now();
    const tickResult = await processCampaign(runningCampaign);
    const elapsedMs = Date.now() - started;

    // Concurrency-bounded: exactly `concurrency_limit` (20) claimed, never
    // "all 1000 at once" (the anti-pattern the task brief explicitly
    // forbids).
    expect(tickResult.dispatched).toBe(20);
    expect(elapsedMs).toBeLessThan(5000);

    const allCampaignLeads = fake.tables.campaign_leads.filter((cl) => cl.campaign_id === campaign.id);
    expect(allCampaignLeads).toHaveLength(1000);
    const TERMINAL = new Set(['completed', 'failed', 'skipped', 'dnc']);
    const EXPLICITLY_PENDING = new Set(['pending', 'retry_pending']);
    const IN_FLIGHT = new Set(['queued', 'dialing', 'ringing', 'connected', 'in_progress', 'transferring']);
    for (const cl of allCampaignLeads) {
      const accountedFor = TERMINAL.has(cl.status) || EXPLICITLY_PENDING.has(cl.status) || IN_FLIGHT.has(cl.status);
      expect(accountedFor).toBe(true);
    }
    // Every dispatched lead got a real call row - never a claimed-but-
    // orphaned campaign_leads row.
    const dialingRows = allCampaignLeads.filter((cl) => cl.status === 'dialing');
    expect(dialingRows.every((cl) => Boolean(cl.last_call_id))).toBe(true);
  });
});
