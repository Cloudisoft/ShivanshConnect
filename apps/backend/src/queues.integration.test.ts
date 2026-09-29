import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

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

describe('Queues API', () => {
  let app: any;

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      throw new Error(`Unexpected fetch call in test: ${String(input)}`);
    }));
    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return { token: res.json().data.session.access_token as string, orgId: res.json().data.organization.id as string };
  }

  it('summarises the outbound queue, due callbacks and inbound calls for the caller\'s organization only', async () => {
    const { token, orgId } = await signup('Queue Org', `queue-${Date.now()}@test.com`);
    const other = await signup('Other Org', `queue-other-${Date.now()}@test.com`);

    const campaignId = randomUUID();
    fake.tables.campaigns.push({ id: campaignId, organization_id: orgId, name: 'MVA', status: 'running', concurrency_limit: 5, updated_at: new Date().toISOString() });
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    fake.tables.campaign_leads.push(
      { id: randomUUID(), campaign_id: campaignId, lead_id: randomUUID(), status: 'pending', next_eligible_at: null },
      { id: randomUUID(), campaign_id: campaignId, lead_id: randomUUID(), status: 'retry_pending', next_eligible_at: past },
      { id: randomUUID(), campaign_id: campaignId, lead_id: randomUUID(), status: 'retry_pending', next_eligible_at: future },
      { id: randomUUID(), campaign_id: campaignId, lead_id: randomUUID(), status: 'completed', next_eligible_at: null },
    );
    const leadId = randomUUID();
    fake.tables.leads.push({ id: leadId, organization_id: orgId, first_name: 'Priya', last_name: 'Shah', phone_normalized: '+14845552222' });
    fake.tables.callbacks.push(
      { id: randomUUID(), organization_id: orgId, campaign_id: campaignId, lead_id: leadId, phone_e164: '+14845552222', scheduled_at: past, timezone: 'America/New_York', status: 'scheduled', assigned_to: 'ai' },
      { id: randomUUID(), organization_id: other.orgId, campaign_id: null, lead_id: randomUUID(), phone_e164: '+14845559999', scheduled_at: past, timezone: 'America/New_York', status: 'scheduled', assigned_to: 'ai' },
    );
    fake.tables.calls.push({ id: randomUUID(), organization_id: orgId, direction: 'inbound', status: 'in_progress', created_at: new Date().toISOString() });

    const res = await app.inject({ method: 'GET', url: '/api/v1/queues/summary', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.outbound).toEqual([
      { campaign_id: campaignId, name: 'MVA', status: 'running', concurrency_limit: 5, waiting_now: 2, scheduled_later: 1, on_call: 0 },
    ]);
    expect(data.callbacks.due_now).toBe(1);
    expect(data.callbacks.upcoming).toHaveLength(1);
    expect(data.callbacks.upcoming[0].lead_name).toBe('Priya Shah');
    expect(data.callbacks.upcoming[0].campaign_name).toBe('MVA');
    expect(data.inbound.on_call).toBe(1);
  });

  it('lets an admin choose which campaign answers a number, never another organization\'s campaign', async () => {
    const { token, orgId } = await signup('Route Org', `route-${Date.now()}@test.com`);
    const other = await signup('Route Other', `route-other-${Date.now()}@test.com`);
    const phoneId = randomUUID();
    fake.tables.phone_numbers.push({ id: phoneId, organization_id: orgId, phone_number: '+14845551111', status: 'active', provider_key: 'twilio', created_at: new Date().toISOString() });
    const ownCampaign = randomUUID();
    const foreignCampaign = randomUUID();
    fake.tables.campaigns.push(
      { id: ownCampaign, organization_id: orgId, name: 'Own', status: 'paused', updated_at: new Date().toISOString() },
      { id: foreignCampaign, organization_id: other.orgId, name: 'Foreign', status: 'running', updated_at: new Date().toISOString() },
    );

    const foreign = await app.inject({ method: 'PATCH', url: `/api/v1/queues/inbound-routes/${phoneId}`, headers: { authorization: `Bearer ${token}` }, payload: { assigned_campaign_id: foreignCampaign } });
    expect(foreign.statusCode).toBe(422);

    const own = await app.inject({ method: 'PATCH', url: `/api/v1/queues/inbound-routes/${phoneId}`, headers: { authorization: `Bearer ${token}` }, payload: { assigned_campaign_id: ownCampaign } });
    expect(own.statusCode).toBe(200);

    const routes = await app.inject({ method: 'GET', url: '/api/v1/queues/inbound-routes', headers: { authorization: `Bearer ${token}` } });
    const route = routes.json().data.routes.find((r: any) => r.phone_number_id === phoneId);
    expect(routes.json().data.campaigns.map((c: any) => c.name)).toEqual(['Own']);
    expect(route.assigned_campaign_id).toBe(ownCampaign);
    expect(route.answered_by_campaign.name).toBe('Own');
    expect(route.answering).toBe(false);
  });
});
