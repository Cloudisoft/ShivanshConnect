import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
}));

const fake = createFakeSupabase();

const { runAggregationTick } = await import('./analyticsAggregator.js');

/**
 * Phase 12 aggregator tests: the one-time backfill runs exactly once
 * (detected by "no historical rollup row exists yet", never a separate
 * flag) and running the whole aggregation tick twice back-to-back never
 * duplicates or double-counts a rollup row - the idempotent-upsert
 * requirement the task brief calls out explicitly.
 */
describe('analyticsAggregator', () => {
  it('backfills every historical date with calls exactly once, and a second tick never duplicates rows or changes their values', async () => {
    const { tables } = fake;
    const orgId = randomUUID();
    tables.organizations.push({ id: orgId, name: 'Backfill Co', slug: 'backfill-co' });

    // Two historical days (2026-01-01, 2026-01-02) with real calls, well
    // before "today" (system clock is real/whatever - as long as these
    // dates are in the past, which anything before this century's end
    // reliably is against this sandbox's real clock).
    const day1 = '2026-01-01';
    const day2 = '2026-01-02';
    for (const [day, count] of [[day1, 3], [day2, 2]] as const) {
      for (let i = 0; i < count; i += 1) {
        tables.calls.push({
          id: randomUUID(),
          organization_id: orgId,
          engine: 'vapi',
          status: i === 0 ? 'completed' : 'failed',
          answered_at: i === 0 ? `${day}T10:00:05.000Z` : null,
          created_at: `${day}T10:00:00.000Z`,
          duration_seconds: i === 0 ? 120 : null,
        });
      }
    }

    await runAggregationTick();

    const rowsAfterFirst = tables.analytics_daily_org.filter((r) => r.organization_id === orgId);
    expect(rowsAfterFirst.map((r) => r.date).sort()).toContain(day1);
    expect(rowsAfterFirst.map((r) => r.date).sort()).toContain(day2);
    const day1RowFirst = rowsAfterFirst.find((r) => r.date === day1)!;
    expect(day1RowFirst.total_calls).toBe(3);
    expect(day1RowFirst.calls_connected).toBe(1);

    const countAfterFirst = tables.analytics_daily_org.length;

    await runAggregationTick();

    // No duplicate rows for org+date, and the historical rows are
    // unchanged (only "today"'s row is expected to be recomputed every
    // tick, and no calls exist for "today" in this test).
    expect(tables.analytics_daily_org.length).toBe(countAfterFirst + 0); // today's row may already exist as zeroed from the first tick
    const day1RowSecond = tables.analytics_daily_org.find((r) => r.organization_id === orgId && r.date === day1)!;
    expect(day1RowSecond.total_calls).toBe(3);
    expect(day1RowSecond.calls_connected).toBe(1);

    // Exactly one row per organization+date - the actual "never
    // duplicated" assertion.
    const day1Rows = tables.analytics_daily_org.filter((r) => r.organization_id === orgId && r.date === day1);
    expect(day1Rows.length).toBe(1);
  });

  it('never touches another organization\'s rollup rows', async () => {
    const { tables } = fake;
    const orgA = randomUUID();
    const orgB = randomUUID();
    tables.organizations.push({ id: orgA, name: 'Org A', slug: `org-a-${orgA}` }, { id: orgB, name: 'Org B', slug: `org-b-${orgB}` });
    tables.calls.push({ id: randomUUID(), organization_id: orgA, engine: 'vapi', status: 'completed', answered_at: '2026-01-05T10:00:05.000Z', created_at: '2026-01-05T10:00:00.000Z', duration_seconds: 60 });

    await runAggregationTick();

    const orgBRows = tables.analytics_daily_org.filter((r) => r.organization_id === orgB && r.date === '2026-01-05');
    expect(orgBRows.length).toBe(0);
  });
});
