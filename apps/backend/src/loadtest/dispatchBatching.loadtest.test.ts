/**
 * Phase 15: proves services/campaignDispatcher.ts's own eligibility query
 * never materializes all 10,000 leads into a single in-memory array at
 * once - it is LIMIT-bounded to `capacity * CANDIDATE_BATCH_MULTIPLIER`
 * (see campaignDispatcher.ts's header + `CANDIDATE_BATCH_MULTIPLIER = 5`),
 * batch by batch, exactly like a real queue consumer would page through
 * work. This is not inferred from reading the source - it is proven by
 * instrumenting the REAL Postgres connection pool this load test's
 * `pgSupabaseAdapter.ts` uses and recording the actual row count of every
 * `campaign_leads` SELECT the dispatcher issues against a genuine
 * 10,000-row table.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgSupabaseAdapter, type PgSupabaseAdapter } from './pgSupabaseAdapter.js';
import { seedOrgBasics, seedCampaign, seedLeads, attachLeadsToCampaign } from './seed.js';
import { installMockVapiFetch } from './mockVapiFetch.js';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(64);

const LOADTEST_DATABASE_URL = process.env.LOADTEST_DATABASE_URL ?? 'postgresql://shivansh:shivansh@localhost:5432/shivanshconnect_loadtest';
const LEAD_COUNT = Number.parseInt(process.env.LOADTEST_LEAD_COUNT ?? '10000', 10);
const SMALL_CONCURRENCY = 20;

let adapter: PgSupabaseAdapter;

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => adapter.supabase,
  getSupabaseAnon: () => adapter.supabase,
}));

describe('Phase 15 load test: the dispatcher never loads all 10k leads into memory at once (LIMIT-bounded, batch by batch)', () => {
  let campaignId: string;
  let processCampaign: typeof import('../services/campaignDispatcher.js').processCampaign;
  const campaignLeadsSelectRowCounts: number[] = [];

  beforeAll(async () => {
    adapter = createPgSupabaseAdapter(LOADTEST_DATABASE_URL);
    await adapter.pool.query('SELECT 1');
    installMockVapiFetch();

    const { registerTerminalCallHandler } = await import('../lib/callStateMachine.js');
    const { handleTerminalCall } = await import('../services/callTerminalHandler.js');
    registerTerminalCallHandler(handleTerminalCall);
    processCampaign = (await import('../services/campaignDispatcher.js')).processCampaign;

    const basics = await seedOrgBasics(adapter, 'Batching Proof Org');
    const leadIds = await seedLeads(adapter, basics.organizationId, LEAD_COUNT);
    const { campaignId: cid } = await seedCampaign(adapter, basics, {
      name: 'Batching proof campaign',
      concurrencyLimit: SMALL_CONCURRENCY,
      maxAttempts: 3,
      retryDelayMinutes: 60,
    });
    campaignId = cid;
    await attachLeadsToCampaign(adapter, basics.organizationId, cid, leadIds);
    process.env.WORKER_POOL_CAPACITY = String(SMALL_CONCURRENCY);

    // Instrument the real pg.Pool.query the adapter uses: every query
    // whose SQL selects FROM campaign_leads has its RESULT row count
    // recorded, so the assertion below is about what Postgres actually
    // returned to the dispatcher, not a guess about its code.
    const originalQuery = adapter.pool.query.bind(adapter.pool);
    vi.spyOn(adapter.pool, 'query').mockImplementation(async (...args: any[]) => {
      const result = await originalQuery(...(args as [any, any?]));
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/FROM public\."campaign_leads"/.test(sql) && /SELECT \*/.test(sql)) {
        campaignLeadsSelectRowCounts.push(result.rows.length);
      }
      return result;
    });
  }, 120_000);

  afterAll(async () => {
    if (adapter) await adapter.close();
  });

  it(`dispatches ${LEAD_COUNT} leads at concurrency=${SMALL_CONCURRENCY} in successive bounded batches, never fetching more than capacity*5 campaign_leads rows in one query`, async () => {
    const supabase = adapter.supabase;
    const maxBatchSize = SMALL_CONCURRENCY * 5; // CANDIDATE_BATCH_MULTIPLIER from campaignDispatcher.ts

    let waves = 0;
    const MAX_WAVES = Math.ceil(LEAD_COUNT / SMALL_CONCURRENCY) + 5;
    for (; waves < MAX_WAVES; waves += 1) {
      const { data: campaignRow } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
      const result = await processCampaign(campaignRow!);
      if (result.dispatched === 0) {
        // Resolve everything currently dialing so the next wave has fresh
        // capacity (this test cares about query SHAPE, not outcome
        // realism - resolve everything as an immediate hangup so it never
        // blocks the batching proof on retry timing).
        const { data: dialing } = await supabase.from('campaign_leads').select('id, last_call_id').eq('campaign_id', campaignId).eq('status', 'dialing');
        if (!dialing || dialing.length === 0) break;
        const { transitionCallState } = await import('../lib/callStateMachine.js');
        await Promise.all(
          dialing.map((cl: any) =>
            transitionCallState(supabase as any, cl.last_call_id, 'failed', { ended_at: new Date().toISOString(), ended_reason: 'no-answer', duration_seconds: 0 }),
          ),
        );
      } else {
        const { data: dialing } = await supabase.from('campaign_leads').select('id, last_call_id').eq('campaign_id', campaignId).eq('status', 'dialing');
        const { transitionCallState } = await import('../lib/callStateMachine.js');
        await Promise.all(
          (dialing ?? []).map((cl: any) =>
            transitionCallState(supabase as any, cl.last_call_id, 'failed', { ended_at: new Date().toISOString(), ended_reason: 'no-answer', duration_seconds: 0 }),
          ),
        );
      }
    }

    expect(campaignLeadsSelectRowCounts.length).toBeGreaterThan(0);
    for (const count of campaignLeadsSelectRowCounts) {
      expect(count).toBeLessThanOrEqual(maxBatchSize);
    }
    // The hard proof this test exists for: NO single query round trip
    // ever returned anywhere close to the full 10,000-row table - every
    // one was bounded to this campaign's own small per-tick batch size.
    expect(Math.max(...campaignLeadsSelectRowCounts)).toBeLessThan(LEAD_COUNT);
    // eslint-disable-next-line no-console
    console.log(
      `[loadtest] dispatcher issued ${campaignLeadsSelectRowCounts.length} campaign_leads SELECT * round trips across ${waves} ticks; ` +
        `max rows returned in any one round trip = ${Math.max(...campaignLeadsSelectRowCounts)} (cap = ${maxBatchSize}, table size = ${LEAD_COUNT})`,
    );
  }, 5 * 60_000);
});
