import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Fresh leads are dialed before already-dialed retries (a newly attached
 * list isn't stuck behind leads that were called before). Same setup as
 * campaigns.integration.test.ts, in its own file so its requests don't
 * count against that file's sign-up rate limit.
 *
 * Original Phase 7 setup notes: campaign create -> attach a 55-lead list ->
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
process.env.BACKEND_PUBLIC_URL = 'http://localhost:4000';

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

let vapiCallCounter = 0;
let vapiAssistantCounter = 0;
let vapiPhoneNumberCounter = 0;

describe('Campaign dialing order', () => {
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
    // Bug: BACKEND_PUBLIC_URL unset used to silently skip webhook
    // registration while still reporting 'connected' - every call placed
    // under that state got stuck at 'dialing' forever with no status
    // updates ever arriving. webhook_url being populated here proves
    // registerWebhook() actually ran, not just that ping() succeeded.
    expect(testConnRes.json().data.webhook_url).toBe('http://localhost:4000/api/v1/webhooks/vapi');

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

  it('dials fresh (never-dialed) leads before already-dialed retries', async () => {
    const token = await signup('Fresh First Org', `fresh-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign, version } = await createCampaignWithLeads(token, agent.id, phoneNumber.id, 8);
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'PATCH', url: `/api/v1/campaigns/${campaign.id}`, headers: { authorization: `Bearer ${token}` }, payload: { transfer_number_e164: '+14845550099' } });
    const startRes = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    expect(startRes.statusCode).toBe(200);

    // Half the list was already dialed once and is due for a retry now.
    const rows = fake.tables.campaign_leads.filter((cl) => cl.campaign_id === campaign.id);
    const dialedBefore = new Set<string>();
    rows.slice(0, 4).forEach((cl) => {
      cl.status = 'retry_pending';
      cl.attempt_count = 1;
      cl.next_eligible_at = new Date(Date.now() - 60_000).toISOString();
      dialedBefore.add(cl.lead_id);
    });

    const result = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    expect(result.dispatched).toBeGreaterThan(0);
    expect(result.dispatched).toBeLessThanOrEqual(4);
    const claimed = fake.tables.campaign_leads.filter((cl) => cl.campaign_id === campaign.id && cl.status === 'dialing');
    expect(claimed).toHaveLength(result.dispatched);
    for (const cl of claimed) expect(dialedBefore.has(cl.lead_id)).toBe(false);
  });

});
