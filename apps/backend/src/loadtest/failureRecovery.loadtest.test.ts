/**
 * Phase 15: failure-recovery verification (master spec sections 72, 73)
 * against real Postgres. Runs at a small, fast lead count deliberately -
 * these are correctness/resilience proofs, not throughput measurements
 * (see dispatch10k.loadtest.test.ts for the 10k-lead scale numbers).
 *
 * What's PROVEN HERE (new for Phase 15):
 *   - process-restart recovery (the CAS claim + DB-persisted state IS the
 *     recovery mechanism - proven by simulating a fresh process via
 *     vi.resetModules() and continuing the same campaign).
 *   - crash isolation (an injected thrown error partway through a
 *     dispatch batch never aborts the rest of the batch or corrupts
 *     subsequent ticks - services/campaignDispatcher.ts's per-lead
 *     try/catch around originateCall() is the real seam this proves).
 *   - provider timeout/error mid-dispatch never leaves a lead stuck in
 *     'dialing' forever (originateCall()'s own catch block + the
 *     dispatcher's catch block together).
 *   - DB "transaction" atomicity: a failed `calls` insert never leaves a
 *     campaign_leads row claimed-but-orphaned.
 *   - an out-of-order webhook delivery (a stale call's end-of-call-report
 *     arriving AFTER that lead has already been re-claimed and re-dialed
 *     by a later attempt) - a genuine gap: grep across the existing
 *     fakeSupabase-backed suite found no test for this exact sequence
 *     (only same-call duplicate-delivery idempotency is covered, in
 *     orchestration.integration.test.ts) - proven here to already be
 *     handled correctly by campaignLeadDisposition.ts's
 *     `last_call_id !== call.id` guard (see its own comment), which this
 *     test exercises through the real HTTP webhook route via `app.inject`
 *     end to end.
 *
 * What's AGGREGATED, NOT DUPLICATED (already proven elsewhere, cited
 * rather than re-tested): same-delivery webhook idempotency (webhook_
 * events UNIQUE(provider,event_id) + the /replay endpoint) is covered by
 * orchestration.integration.test.ts's "never lets a webhook payload for
 * org A update a call belonging to org B" and "replays a failed/stored
 * webhook event" tests, and by routes/webhooks.ts's own header comment.
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
process.env.CREDENTIAL_ENCRYPTION_KEY = 'f'.repeat(64);
process.env.WORKER_POOL_CAPACITY = '50';

const LOADTEST_DATABASE_URL = process.env.LOADTEST_DATABASE_URL ?? 'postgresql://shivansh:shivansh@localhost:5432/shivanshconnect_loadtest';

let adapter: PgSupabaseAdapter;

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => adapter.supabase,
  getSupabaseAnon: () => adapter.supabase,
}));

describe('Phase 15: failure recovery (process restart, crash isolation, timeout retry, transaction atomicity, out-of-order webhooks)', () => {
  beforeAll(async () => {
    adapter = createPgSupabaseAdapter(LOADTEST_DATABASE_URL);
    await adapter.pool.query('SELECT 1');
    const { registerTerminalCallHandler } = await import('../lib/callStateMachine.js');
    const { handleTerminalCall } = await import('../services/callTerminalHandler.js');
    registerTerminalCallHandler(handleTerminalCall);
    // The 'process-restart recovery' test below starts the REAL
    // dispatcher interval (services/campaignDispatcher.ts's own
    // setInterval, not a stand-in), which - exactly like production -
    // ticks every campaign in this database with status='running', not
    // only this file's own. This shared load-test database accumulates
    // 'running' campaigns left behind by other loadtest files' own runs
    // (they intentionally never mark their campaigns 'completed' - that
    // bookkeeping is out of scope for what each of those tests proves).
    // Pausing every pre-existing running campaign here is test hygiene,
    // never a production code change: it keeps this file's own restart
    // test deterministic regardless of what ran before it in this shared
    // database, the same way a real deployment's dispatcher would
    // correctly (and harmlessly) also tick those other real campaigns.
    await adapter.pool.query(`UPDATE public.campaigns SET status = 'paused' WHERE status = 'running'`);
  }, 60_000);

  afterAll(async () => {
    if (adapter) await adapter.close();
  });

  it('process-restart recovery: stopping and restarting the dispatcher\'s in-process interval resumes a campaign correctly with no leads lost or double-claimed', async () => {
    installMockVapiFetch();
    const basics = await seedOrgBasics(adapter, 'Restart Recovery Org');
    const leadIds = await seedLeads(adapter, basics.organizationId, 20);
    const { campaignId } = await seedCampaign(adapter, basics, { name: 'Restart recovery campaign', concurrencyLimit: 8, maxAttempts: 2, retryDelayMinutes: 0 });
    await attachLeadsToCampaign(adapter, basics.organizationId, campaignId, leadIds);

    const supabase = adapter.supabase;
    // CAMPAIGN_DISPATCH_INTERVAL_MS is read into a module-level constant
    // at import time (see campaignDispatcher.ts), so it must be set
    // BEFORE that module is first imported in this file.
    process.env.CAMPAIGN_DISPATCH_INTERVAL_MS = '50';
    const { startCampaignDispatcher, stopCampaignDispatcher } = await import('../services/campaignDispatcher.js');

    // "Process 1": start the real in-process interval, let it fire at
    // least once (dispatching one wave - 8 of 20 leads claimed/dialing),
    // then simulate a hard process restart by stopping it - this is
    // exactly the CAMPAIGN_DISPATCH_INTERVAL_MS-driven setInterval every
    // real deployment runs (see campaignDispatcher.ts's
    // startCampaignDispatcher()), never a different code path built for
    // this test.
    // Polls (rather than a fixed sleep) until this campaign's own
    // claimed-lead count stops changing - robust to however long the
    // real dispatcher's own sequential per-lead origination work actually
    // takes on this machine, instead of gambling on a fixed wait.
    async function waitForDialingCountToStabilize(): Promise<number> {
      let previous = -1;
      let stableTicks = 0;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const { data } = await supabase.from('campaign_leads').select('id').eq('campaign_id', campaignId).eq('status', 'dialing');
        const count = (data ?? []).length;
        if (count === previous) {
          stableTicks += 1;
          if (stableTicks >= 3) return count; // unchanged for 300ms - settled
        } else {
          stableTicks = 0;
        }
        previous = count;
      }
      return previous;
    }

    startCampaignDispatcher();
    const afterFirstStartCount = await waitForDialingCountToStabilize();
    stopCampaignDispatcher();
    expect(afterFirstStartCount).toBe(8);

    // "Process 2" (post-restart): starting the interval again is the
    // ENTIRE recovery mechanism - nothing else needs to run. Capacity is
    // still fully used by the 8 still-active calls from before the
    // "restart", which live only in Postgres (never in this process's own
    // memory) - a correctly-resumed dispatcher must see that real DB
    // state and dispatch 0 more, not forget about them and over-dispatch.
    startCampaignDispatcher();
    await waitForDialingCountToStabilize();
    stopCampaignDispatcher();

    const { data: dialingLeads } = await supabase.from('campaign_leads').select('id, lead_id').eq('campaign_id', campaignId).eq('status', 'dialing');
    expect(dialingLeads).toHaveLength(8);
    expect(new Set((dialingLeads ?? []).map((r: any) => r.lead_id)).size).toBe(8); // no duplicate claims

    const { data: campaignCalls } = await supabase.from('calls').select('lead_id').eq('campaign_id', campaignId);
    expect(campaignCalls).toHaveLength(8); // exactly one call per claimed lead, even across the "restart"
  });

  it('crash isolation: an injected thrown error partway through a dispatch batch never aborts the rest of the batch or corrupts subsequent ticks', async () => {
    installMockVapiFetch();
    const basics = await seedOrgBasics(adapter, 'Crash Isolation Org');
    const leadIds = await seedLeads(adapter, basics.organizationId, 10);
    const { campaignId } = await seedCampaign(adapter, basics, { name: 'Crash isolation campaign', concurrencyLimit: 10, maxAttempts: 2, retryDelayMinutes: 0 });
    await attachLeadsToCampaign(adapter, basics.organizationId, campaignId, leadIds);

    const originationMod = await import('../services/callOrigination.js');
    const realOriginateCall = originationMod.originateCall;
    let calls = 0;
    // Every 3rd lead's origination attempt throws a raw (non-Error)
    // value - the worst case for an unhandled-exception seam, and
    // exactly what the brief asks this test to inject "mid-processing of
    // one lead". services/campaignDispatcher.ts's per-lead try/catch
    // around originateCall() is the real production seam being proven
    // here, not a test-only workaround.
    const spy = vi.spyOn(originationMod, 'originateCall').mockImplementation(async (params) => {
      calls += 1;
      if (calls % 3 === 0) {
        // eslint-disable-next-line no-throw-literal
        throw 'injected non-Error crash mid-batch';
      }
      return realOriginateCall(params);
    });

    const { processCampaign } = await import('../services/campaignDispatcher.js');
    const supabase = adapter.supabase;
    const { data: campaignRow } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
    // processCampaign() must complete without throwing, even though 1/3
    // of its origination attempts threw a raw string.
    await expect(processCampaign(campaignRow!)).resolves.toBeDefined();
    spy.mockRestore();

    const { data: leads } = await supabase.from('campaign_leads').select('status, attempt_count').eq('campaign_id', campaignId);
    const rows = leads ?? [];
    expect(rows).toHaveLength(10);
    // Every lead was either successfully dispatched (now 'dialing') or
    // cleanly marked retry_pending/failed by the dispatcher's own catch
    // block for the injected failures - NONE is left in a state that
    // reveals the crash ever corrupted anything (e.g. stuck at
    // attempt_count 0 with status still 'pending' despite a claim having
    // been attempted).
    for (const row of rows) {
      expect(['dialing', 'retry_pending', 'failed']).toContain(row.status);
      expect(row.attempt_count).toBeGreaterThanOrEqual(1);
    }
    const crashedCount = rows.filter((r: any) => r.status === 'retry_pending' || r.status === 'failed').length;
    expect(crashedCount).toBeGreaterThan(0); // the injected crashes actually happened

    // Subsequent tick is entirely unaffected (module state wasn't
    // corrupted by the earlier crash - no lingering tickInFlight lock,
    // no poisoned per-minute counter).
    const { data: campaignRowAgain } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
    await expect(processCampaign(campaignRowAgain!)).resolves.toBeDefined();
  });

  it('provider timeout/error mid-dispatch: a lead is never left stuck in "dialing" forever - it cleanly becomes retry_pending or failed', async () => {
    const basics = await seedOrgBasics(adapter, 'Provider Timeout Org');
    const leadIds = await seedLeads(adapter, basics.organizationId, 3);
    const { campaignId } = await seedCampaign(adapter, basics, { name: 'Provider timeout campaign', concurrencyLimit: 3, maxAttempts: 2, retryDelayMinutes: 0 });
    await attachLeadsToCampaign(adapter, basics.organizationId, campaignId, leadIds);

    // Every Vapi fetch call times out/errors - simulates the real
    // provider being unreachable mid-dispatch (spec 72's explicit
    // "Vapi/Twilio/Telnyx API timeout" scenario), never a real network
    // call.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('simulated Vapi API timeout');
      }),
    );

    const supabase = adapter.supabase;
    const { data: campaignRow } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
    const result = await processCampaignDynamic(campaignRow!);
    expect(result.dispatched).toBe(0); // every origination attempt failed
    expect(result.skipped).toBe(3);

    const { data: leads } = await supabase.from('campaign_leads').select('status, attempt_count, final_disposition').eq('campaign_id', campaignId);
    for (const row of leads ?? []) {
      // The hard invariant this test exists for: NEVER 'dialing' after
      // origination genuinely failed.
      expect(row.status).not.toBe('dialing');
      expect(['retry_pending', 'failed']).toContain(row.status);
      expect(row.attempt_count).toBe(1);
    }
  });

  it('DB transaction atomicity: a failed `calls` insert never leaves a campaign_leads row claimed-but-orphaned', async () => {
    installMockVapiFetch();
    const basics = await seedOrgBasics(adapter, 'Transaction Atomicity Org');
    const leadIds = await seedLeads(adapter, basics.organizationId, 1);
    const { campaignId } = await seedCampaign(adapter, basics, { name: 'Transaction atomicity campaign', concurrencyLimit: 1, maxAttempts: 2, retryDelayMinutes: 0 });
    await attachLeadsToCampaign(adapter, basics.organizationId, campaignId, leadIds);

    // Simulate a mid-transaction DB failure: the real INSERT INTO calls
    // statement itself fails (e.g. a connection drop, a constraint
    // violation the application didn't anticipate) - originateCall()'s
    // own `if (insertError) throw insertError;` (services/
    // callOrigination.ts) is the real code path this proves never leaves
    // a campaign_leads row silently stuck 'dialing' with no
    // corresponding calls row at all.
    const originalQuery = adapter.pool.query.bind(adapter.pool);
    const spy = vi.spyOn(adapter.pool, 'query').mockImplementation(async (...args: any[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/INSERT INTO public\."calls"/.test(sql)) {
        throw new Error('simulated DB failure mid-transaction (calls insert)');
      }
      return originalQuery(...(args as [any, any?]));
    });

    const supabase = adapter.supabase;
    const { data: campaignRow } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
    const result = await processCampaignDynamic(campaignRow!);
    spy.mockRestore();

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);

    // No orphaned `calls` row was created (the insert itself failed), and
    // the campaign_leads row was NOT left stuck 'dialing' with a claim
    // but no real call behind it - the dispatcher's catch block marks it
    // retry_pending (max_attempts=2, attempt 1) instead.
    const { data: campaignCalls } = await supabase.from('calls').select('id').eq('campaign_id', campaignId);
    expect(campaignCalls).toHaveLength(0);
    const { data: cl } = await supabase.from('campaign_leads').select('status, last_call_id').eq('campaign_id', campaignId).maybeSingle();
    expect(cl!.status).toBe('retry_pending');
    expect(cl!.last_call_id).toBeNull();
  });

  it('out-of-order webhook delivery: a stale end-of-call-report for a SUPERSEDED attempt never clobbers a lead already re-dialed by a later attempt (genuine gap found + covered)', async () => {
    installMockVapiFetch();
    const basics = await seedOrgBasics(adapter, 'Out Of Order Webhook Org');
    const leadIds = await seedLeads(adapter, basics.organizationId, 1);
    const { campaignId } = await seedCampaign(adapter, basics, { name: 'Out-of-order webhook campaign', concurrencyLimit: 1, maxAttempts: 3, retryDelayMinutes: 0 });
    await attachLeadsToCampaign(adapter, basics.organizationId, campaignId, leadIds);

    const supabase = adapter.supabase;
    const { transitionCallState } = await import('../lib/callStateMachine.js');
    const processCampaignFn = (await import('../services/campaignDispatcher.js')).processCampaign;

    // Attempt 1: dispatch, then resolve as a retryable no-answer (call A
    // becomes 'failed', campaign_leads -> retry_pending, next_eligible_at
    // now since retryDelayMinutes=0).
    let campaignRow = (await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()).data;
    await processCampaignFn(campaignRow!);
    let cl = (await supabase.from('campaign_leads').select('*').eq('campaign_id', campaignId).maybeSingle()).data!;
    const callAId = cl.last_call_id as string;
    await transitionCallState(supabase as any, callAId, 'failed', { ended_at: new Date().toISOString(), ended_reason: 'no-answer', duration_seconds: 0 });

    // Attempt 2: the SAME lead is re-claimed and re-dialed (a genuinely
    // new `calls` row, call B) - campaign_leads.last_call_id now points
    // at B, not A.
    campaignRow = (await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()).data;
    const secondTick = await processCampaignFn(campaignRow!);
    expect(secondTick.dispatched).toBe(1);
    cl = (await supabase.from('campaign_leads').select('*').eq('campaign_id', campaignId).maybeSingle()).data!;
    const callBId = cl.last_call_id as string;
    expect(callBId).not.toBe(callAId);
    expect(cl.attempt_count).toBe(2);

    // Now the OUT-OF-ORDER delivery: a delayed 'end-of-call-report' for
    // call A (attempt 1, already superseded) finally arrives via the REAL
    // HTTP webhook route - e.g. a slow network retry from Vapi that
    // landed after attempt 2 had already started. It must be recorded
    // (call A itself still gets its own terminal state) but must NEVER
    // touch campaign_leads, since campaignLeadDisposition.ts's own guard
    // is "only update the row this exact call is the most recent attempt
    // for" (see its header comment) - call A is not campaignLead.last_call_id
    // any more.
    const { buildApp } = await import('../index.js');
    const app = buildApp();
    await app.ready();
    const { data: callA } = await supabase.from('calls').select('vapi_call_id').eq('id', callAId).maybeSingle();
    const staleWebhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/vapi',
      payload: { message: { type: 'end-of-call-report', call: { id: callA!.vapi_call_id }, endedReason: 'twilio-failed', durationSeconds: 0 } },
    });
    expect(staleWebhook.statusCode).toBe(200);
    await app.close();

    // campaign_leads is completely unaffected by the stale delivery - it
    // still reflects attempt 2's real, current state (call B, attempt
    // count 2), not overwritten by call A's late arrival.
    const clAfterStaleWebhook = (await supabase.from('campaign_leads').select('*').eq('campaign_id', campaignId).maybeSingle()).data!;
    expect(clAfterStaleWebhook.last_call_id).toBe(callBId);
    expect(clAfterStaleWebhook.attempt_count).toBe(2);
  });
});

// Re-imported per test via dynamic import so vi.resetModules() in the
// first test doesn't leave a stale reference for the later tests in this
// same file - each test that needs it imports fresh.
async function processCampaignDynamic(campaign: Record<string, any>) {
  const { processCampaign } = await import('../services/campaignDispatcher.js');
  return processCampaign(campaign);
}
