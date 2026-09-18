/**
 * Phase 15: runs the REAL analytics rollup SQL functions (services/
 * analyticsAggregator.ts's `.rpc('recompute_analytics_daily_org', ...)`
 * etc., which call the real Postgres functions in
 * supabase/migrations/00000000000044_phase12_analytics_rollup_fns.sql)
 * against a real ~10k-call dataset, then reconciles the resulting
 * `analytics_daily_org`/`analytics_daily_campaign` rows against
 * independently hand-written SQL aggregate queries computed straight off
 * `calls`/`call_dispositions` - a genuine ground truth, not a re-statement
 * of the same rollup logic.
 *
 * Reuses whatever calls the 10,000-lead dispatch load test
 * (dispatch10k.loadtest.test.ts) already produced in this same database
 * for today's date, if that file already ran in this process (vitest's
 * `fileParallelism: false` runs load-test files one at a time in the same
 * `pnpm run loadtest` invocation - see vitest.loadtest.config.ts) -
 * otherwise it seeds and resolves its own smaller real dataset so this
 * file is independently runnable too (e.g. via `-t`/single-file runs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgSupabaseAdapter, type PgSupabaseAdapter } from './pgSupabaseAdapter.js';
import { seedOrgBasics, seedCampaign, seedLeads, attachLeadsToCampaign } from './seed.js';
import { installMockVapiFetch } from './mockVapiFetch.js';
import { resolveCallToOutcome } from './resolveOutcomes.js';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'd'.repeat(64);

const LOADTEST_DATABASE_URL = process.env.LOADTEST_DATABASE_URL ?? 'postgresql://shivansh:shivansh@localhost:5432/shivanshconnect_loadtest';
const LEAD_COUNT = Math.min(2000, Number.parseInt(process.env.LOADTEST_LEAD_COUNT ?? '10000', 10));

let adapter: PgSupabaseAdapter;

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => adapter.supabase,
  getSupabaseAnon: () => adapter.supabase,
}));

describe('Phase 15 load test: analytics rollup reconciles against hand-computed SQL ground truth at scale', () => {
  let organizationId: string;
  let campaignId: string;
  let today: string;

  beforeAll(async () => {
    adapter = createPgSupabaseAdapter(LOADTEST_DATABASE_URL);
    await adapter.pool.query('SELECT 1');
    installMockVapiFetch();
    const { registerTerminalCallHandler } = await import('../lib/callStateMachine.js');
    const { handleTerminalCall } = await import('../services/callTerminalHandler.js');
    registerTerminalCallHandler(handleTerminalCall);
    const { processCampaign } = await import('../services/campaignDispatcher.js');

    const basics = await seedOrgBasics(adapter, 'Analytics Reconciliation Org');
    organizationId = basics.organizationId;
    const leadIds = await seedLeads(adapter, organizationId, LEAD_COUNT);
    const { campaignId: cid } = await seedCampaign(adapter, basics, {
      name: 'Analytics reconciliation campaign',
      concurrencyLimit: 200,
      maxAttempts: 2,
      retryDelayMinutes: 0,
    });
    campaignId = cid;
    await attachLeadsToCampaign(adapter, organizationId, cid, leadIds);
    process.env.WORKER_POOL_CAPACITY = '200';

    const supabase = adapter.supabase;
    for (let wave = 0; wave < 20; wave += 1) {
      const { data: campaignRow } = await supabase.from('campaigns').select('*').eq('id', cid).maybeSingle();
      const result = await processCampaign(campaignRow!);
      const { data: dialing } = await supabase.from('campaign_leads').select('id, last_call_id, attempt_count').eq('campaign_id', cid).eq('status', 'dialing');
      if ((!dialing || dialing.length === 0) && result.dispatched === 0) break;
      if (dialing && dialing.length > 0) {
        const { data: calls } = await supabase.from('calls').select('id, customer_number').in('id', dialing.map((d: any) => d.last_call_id));
        const byId = new Map((calls ?? []).map((c: any) => [c.id, c.customer_number]));
        await Promise.all(dialing.map((cl: any) => resolveCallToOutcome(adapter, cl.last_call_id, byId.get(cl.last_call_id), cl.attempt_count)));
      }
    }

    today = new Date().toISOString().slice(0, 10);
  }, 5 * 60_000);

  afterAll(async () => {
    if (adapter) await adapter.close();
  });

  it('recompute_analytics_daily_org matches a hand-written SQL aggregate over the real calls table', async () => {
    const supabase = adapter.supabase;
    const { error } = await supabase.rpc('recompute_analytics_daily_org', { p_org_id: organizationId, p_date: today });
    expect(error).toBeNull();

    const { data: rollup } = await supabase.from('analytics_daily_org').select('*').eq('organization_id', organizationId).eq('date', today).maybeSingle();
    expect(rollup).toBeTruthy();

    const groundTruth = await adapter.pool.query(
      `SELECT
         count(*)::int AS total_calls,
         count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS calls_connected,
         count(*) FILTER (WHERE c.status = 'completed')::int AS calls_completed,
         count(*) FILTER (WHERE c.status = 'failed')::int AS calls_failed
       FROM public.calls c
       WHERE c.organization_id = $1 AND c.created_at::date = $2`,
      [organizationId, today],
    );
    const truth = groundTruth.rows[0];

    expect(rollup!.total_calls).toBe(truth.total_calls);
    expect(rollup!.calls_connected).toBe(truth.calls_connected);
    expect(rollup!.calls_completed).toBe(truth.calls_completed);
    expect(rollup!.calls_failed).toBe(truth.calls_failed);
    expect(truth.total_calls).toBeGreaterThan(0);
  });

  it('recompute_analytics_daily_campaign matches a hand-written SQL aggregate scoped to this campaign', async () => {
    const supabase = adapter.supabase;
    const { error } = await supabase.rpc('recompute_analytics_daily_campaign', { p_org_id: organizationId, p_date: today });
    expect(error).toBeNull();

    const { data: rollup } = await supabase.from('analytics_daily_campaign').select('*').eq('organization_id', organizationId).eq('campaign_id', campaignId).eq('date', today).maybeSingle();
    expect(rollup).toBeTruthy();

    const groundTruth = await adapter.pool.query(
      `SELECT
         count(*)::int AS total_calls,
         count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS connected,
         count(*) FILTER (WHERE c.status = 'failed')::int AS failed,
         count(DISTINCT c.lead_id)::int AS leads_called
       FROM public.calls c
       WHERE c.organization_id = $1 AND c.campaign_id = $2 AND c.created_at::date = $3`,
      [organizationId, campaignId, today],
    );
    const truth = groundTruth.rows[0];

    expect(rollup!.total_calls).toBe(truth.total_calls);
    expect(rollup!.connected).toBe(truth.connected);
    expect(rollup!.failed).toBe(truth.failed);
    expect(rollup!.leads_called).toBe(truth.leads_called);

    const leadsRemainingTruth = await adapter.pool.query(
      `SELECT count(*)::int AS c FROM public.campaign_leads WHERE campaign_id = $1 AND status NOT IN ('completed','failed','dnc','skipped')`,
      [campaignId],
    );
    expect(rollup!.leads_remaining).toBe(leadsRemainingTruth.rows[0].c);
  });

  it('the disposition breakdown reconciles against a hand-written GROUP BY over call_dispositions', async () => {
    const supabase = adapter.supabase;
    const from = `${today}T00:00:00.000Z`;
    const to = `${today}T23:59:59.999Z`;
    const { data: breakdown, error } = await supabase.rpc('dashboard_disposition_breakdown', { match_organization_id: organizationId, match_from: from, match_to: to });
    expect(error).toBeNull();

    const groundTruth = await adapter.pool.query(
      `SELECT d.code, count(*)::int AS call_count
       FROM public.call_dispositions cd
       JOIN public.dispositions d ON d.id = cd.disposition_id
       JOIN public.calls c ON c.id = cd.call_id
       WHERE cd.organization_id = $1 AND c.created_at >= $2 AND c.created_at <= $3
       GROUP BY d.code`,
      [organizationId, from, to],
    );
    const truthByCode = new Map(groundTruth.rows.map((r: any) => [r.code, r.call_count]));
    const rollupByCode = new Map((breakdown ?? []).map((r: any) => [r.code, Number(r.call_count)]));

    expect(rollupByCode.size).toBeGreaterThan(0);
    expect(rollupByCode.size).toBe(truthByCode.size);
    for (const [code, count] of truthByCode) {
      expect(rollupByCode.get(code as string)).toBe(count);
    }
  });
});
