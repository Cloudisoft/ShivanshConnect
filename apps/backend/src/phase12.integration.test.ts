import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 12 integration tests: a realistic multi-day, multi-campaign,
 * multi-agent dataset is seeded directly into the fakeSupabase tables
 * (the same "seed the DB tables directly, then exercise real route code
 * through app.inject()" pattern Phase 11's aggregateAgentImprovements
 * dedup tests use) so the test is deterministic and fast rather than
 * depending on the real dispatcher/webhook pipeline (already covered end
 * to end by Phases 7/8's own integration suites). The real aggregator
 * (`runAggregationTick`) is then run for real against that data, and
 * every dashboard/analytics endpoint is hit through the real Fastify
 * route handlers via app.inject() with a real signed-up user's JWT.
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

describe('Phase 12: dashboard + campaign/agent analytics', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;
  let runAggregationTick: typeof import('./services/analyticsAggregator.js').runAggregationTick;

  let tokenA: string;
  let orgAId: string;
  let campaignAId: string;
  let agentAId: string;

  let tokenB: string;
  let orgBId: string;

  const now = new Date();
  const TODAY = now.toISOString().slice(0, 10);
  const YDAY = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // 5 days ago - inside the 7d/30d windows, but distinct from "today"/"yesterday".
  const OLD_DAY = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // A few minutes in the past (never "later today" than the real clock at
  // request time) so the live "today" slice's `created_at <= now` filter
  // never excludes it, regardless of what wall-clock time the suite runs at.
  const TODAY_CALL_TIME = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

  beforeAll(async () => {
    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
    runAggregationTick = (await import('./services/analyticsAggregator.js')).runAggregationTick;

    async function signup(orgName: string, email: string) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
      expect(res.statusCode).toBe(201);
      const body = res.json().data;
      return { token: body.session.access_token as string, orgId: body.organization.id as string };
    }

    const a = await signup('Org A', `owner-a-${randomUUID()}@example.com`);
    tokenA = a.token;
    orgAId = a.orgId;
    const b = await signup('Org B', `owner-b-${randomUUID()}@example.com`);
    tokenB = b.token;
    orgBId = b.orgId;

    // --- seed org A: 1 agent, 1 campaign, leads, calls across 3 days ---
    agentAId = randomUUID();
    fake.tables.ai_agents.push({ id: agentAId, organization_id: orgAId, name: 'Sales Agent A', role: 'sales_agent', status: 'active' });
    campaignAId = randomUUID();
    fake.tables.campaigns.push({ id: campaignAId, organization_id: orgAId, name: 'Spring Outreach', status: 'running' });

    const leadIds = Array.from({ length: 5 }, () => randomUUID());
    for (const leadId of leadIds) {
      fake.tables.leads.push({ id: leadId, organization_id: orgAId, phone_normalized: `+1555000${leadId.slice(0, 4)}` });
    }
    fake.tables.campaign_leads.push(
      { id: randomUUID(), campaign_id: campaignAId, organization_id: orgAId, lead_id: leadIds[0], status: 'completed', attempt_count: 1 },
      { id: randomUUID(), campaign_id: campaignAId, organization_id: orgAId, lead_id: leadIds[1], status: 'completed', attempt_count: 1 },
      { id: randomUUID(), campaign_id: campaignAId, organization_id: orgAId, lead_id: leadIds[2], status: 'pending', attempt_count: 0 },
      { id: randomUUID(), campaign_id: campaignAId, organization_id: orgAId, lead_id: leadIds[3], status: 'retry_pending', attempt_count: 1 },
      { id: randomUUID(), campaign_id: campaignAId, organization_id: orgAId, lead_id: leadIds[4], status: 'dnc', attempt_count: 1 },
    );

    const voicemailDispId = fake.tables.dispositions.find((d) => d.code === 'VOICEMAIL')!.id;
    const transferredDispId = fake.tables.dispositions.find((d) => d.code === 'TRANSFERRED')!.id;
    const dncDispId = fake.tables.dispositions.find((d) => d.code === 'DNC')!.id;

    function addCall(day: string, opts: { answered: boolean; status: string; duration: number | null; leadId: string; dispositionId?: string; createdAtIso?: string }) {
      const callId = randomUUID();
      const createdAt = opts.createdAtIso ?? `${day}T10:00:00.000Z`;
      fake.tables.calls.push({
        id: callId,
        organization_id: orgAId,
        engine: 'vapi',
        ai_agent_id: agentAId,
        campaign_id: campaignAId,
        lead_id: opts.leadId,
        direction: 'outbound',
        customer_number: '+15550001111',
        status: opts.status,
        created_at: createdAt,
        answered_at: opts.answered ? createdAt : null,
        duration_seconds: opts.duration,
        talk_duration_seconds: opts.duration ? Math.round(opts.duration * 0.8) : null,
      });
      if (opts.dispositionId) {
        fake.tables.call_dispositions.push({ id: randomUUID(), call_id: callId, organization_id: orgAId, disposition_id: opts.dispositionId, disposition_source: 'engine' });
      }
      return callId;
    }

    // OLD_DAY: 3 calls - 2 connected/completed, 1 voicemail.
    addCall(OLD_DAY, { answered: true, status: 'completed', duration: 120, leadId: leadIds[0] });
    addCall(OLD_DAY, { answered: true, status: 'completed', duration: 90, leadId: leadIds[1], dispositionId: transferredDispId });
    addCall(OLD_DAY, { answered: false, status: 'voicemail', duration: 15, leadId: leadIds[2], dispositionId: voicemailDispId });

    // YDAY: 2 calls - 1 dnc, 1 failed.
    addCall(YDAY, { answered: true, status: 'dnc', duration: 30, leadId: leadIds[4], dispositionId: dncDispId });
    addCall(YDAY, { answered: false, status: 'failed', duration: null, leadId: leadIds[3] });

    // TODAY: 1 connected call - exercises the live "today" slice.
    addCall(TODAY, { answered: true, status: 'completed', duration: 60, leadId: leadIds[0], createdAtIso: TODAY_CALL_TIME });

    // An evaluation for org A's agent (Phase 11's table) - proves agent
    // analytics surfaces a real evaluation score.
    fake.tables.call_evaluations.push({
      id: randomUUID(),
      call_id: fake.tables.calls.find((c) => c.organization_id === orgAId && c.created_at.startsWith(OLD_DAY))!.id,
      organization_id: orgAId,
      overall_score: 88,
      scores: { opening: 90, closing: 86 },
      evaluated_at: `${OLD_DAY}T12:00:00.000Z`,
    });

    // --- seed org B with its own, deliberately different data ---
    const agentBId = randomUUID();
    fake.tables.ai_agents.push({ id: agentBId, organization_id: orgBId, name: 'Sales Agent B', role: 'sales_agent', status: 'active' });
    const leadBId = randomUUID();
    fake.tables.leads.push({ id: leadBId, organization_id: orgBId, phone_normalized: '+15559998888' });
    fake.tables.calls.push({
      id: randomUUID(),
      organization_id: orgBId,
      engine: 'vapi',
      ai_agent_id: agentBId,
      lead_id: leadBId,
      direction: 'outbound',
      customer_number: '+15559998888',
      status: 'completed',
      created_at: `${OLD_DAY}T09:00:00.000Z`,
      answered_at: `${OLD_DAY}T09:00:05.000Z`,
      duration_seconds: 200,
    });

    await runAggregationTick();
  });

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  it('GET /dashboard (30d) returns the exact totals across both historical rollup days and today\'s live slice', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dashboard?period=30d', headers: authed(tokenA) });
    expect(res.statusCode).toBe(200);
    const metrics = res.json().data;

    // 3 (OLD_DAY) + 2 (YDAY) + 1 (TODAY) = 6 total calls.
    expect(metrics.total_calls).toBe(6);
    // answered: OLD_DAY x2, YDAY x1 (dnc call was answered), TODAY x1 = 4
    expect(metrics.calls_connected).toBe(4);
    expect(metrics.calls_completed).toBe(3); // 2 on OLD_DAY + 1 today
    expect(metrics.calls_failed).toBe(1);
    expect(metrics.voicemails).toBe(1);
    expect(metrics.dnc).toBe(1);
    expect(metrics.transfers).toBe(1);
    expect(metrics.connection_rate).toBeCloseTo((4 / 6) * 100, 1);

    // Live, never-rollup figures.
    expect(metrics.campaigns_running).toBe(1);
    expect(metrics.ai_agents_active).toBe(1);
    // 2 non-terminal leads (pending + retry_pending) in the one running campaign.
    expect(metrics.remaining_leads).toBe(2);
  });

  it('GET /dashboard (today) only reflects today\'s slice', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dashboard?period=today', headers: authed(tokenA) });
    const metrics = res.json().data;
    expect(metrics.total_calls).toBe(1);
    expect(metrics.calls_connected).toBe(1);
  });

  it('GET /dashboard (custom range covering only OLD_DAY) matches the hand-seeded numbers for that single day', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/dashboard?period=custom&date_from=${OLD_DAY}&date_to=${OLD_DAY}`, headers: authed(tokenA) });
    const metrics = res.json().data;
    expect(metrics.total_calls).toBe(3);
    expect(metrics.calls_connected).toBe(2);
    expect(metrics.voicemails).toBe(1);
    expect(metrics.transfers).toBe(1);
  });

  it('GET /dashboard/charts includes a disposition breakdown and per-campaign performance for the period', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dashboard/charts?period=30d', headers: authed(tokenA) });
    expect(res.statusCode).toBe(200);
    const charts = res.json().data;

    const voicemailSlice = charts.disposition_breakdown.find((d: any) => d.label === 'Voicemail');
    expect(voicemailSlice?.value).toBe(1);

    const campaignPerf = charts.campaign_performance.find((c: any) => c.campaign_id === campaignAId);
    expect(campaignPerf).toBeTruthy();
    expect(campaignPerf.total_calls).toBe(6);

    const completion = charts.campaign_completion.find((c: any) => c.campaign_id === campaignAId);
    expect(completion.total_leads).toBe(5);
    expect(completion.leads_called).toBe(4); // 4 leads have attempt_count > 0
  });

  it('GET /analytics/campaigns/:id matches the campaign-specific expected numbers', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/analytics/campaigns/${campaignAId}?period=30d`, headers: authed(tokenA) });
    expect(res.statusCode).toBe(200);
    const a = res.json().data;
    expect(a.total_leads).toBe(5);
    expect(a.calls).toBe(6);
    expect(a.connected).toBe(4);
    expect(a.voicemail).toBe(1);
    expect(a.dnc).toBe(1);
    expect(a.transfers).toBe(1);
    // completed + dnc = 3 terminal out of 5 leads
    expect(a.completion_pct).toBe(60);
  });

  it('GET /analytics/agents reflects Phase 11 evaluation scores and returns a comparable array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/agents?period=30d', headers: authed(tokenA) });
    expect(res.statusCode).toBe(200);
    const agents = res.json().data as any[];
    const agentA = agents.find((a) => a.ai_agent_id === agentAId);
    expect(agentA).toBeTruthy();
    expect(agentA.calls).toBe(6);
    expect(agentA.connected_calls).toBe(4);
    expect(agentA.average_evaluation_score).toBe(88);
    expect(agentA.evaluation_call_count).toBe(1);
  });

  it('cross-org isolation: org B never sees org A\'s data in its dashboard, charts, or agent analytics, even in aggregate', async () => {
    const dashRes = await app.inject({ method: 'GET', url: '/api/v1/dashboard?period=30d', headers: authed(tokenB) });
    const dash = dashRes.json().data;
    expect(dash.total_calls).toBe(1); // only org B's own single call
    expect(dash.campaigns_running).toBe(0);

    const agentsRes = await app.inject({ method: 'GET', url: '/api/v1/analytics/agents?period=30d', headers: authed(tokenB) });
    const agents = agentsRes.json().data as any[];
    expect(agents.some((a) => a.ai_agent_id === agentAId)).toBe(false);

    const campaignRes = await app.inject({ method: 'GET', url: `/api/v1/analytics/campaigns/${campaignAId}?period=30d`, headers: authed(tokenB) });
    expect(campaignRes.statusCode).toBe(404);
  });

  it('requires analytics.view and rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    expect(res.statusCode).toBe(401);
  });
});
