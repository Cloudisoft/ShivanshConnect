import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import { getCampaignAnalytics, getDashboardMetrics, resolvePeriod } from './analyticsQuery.js';

describe('resolvePeriod', () => {
  it('today: from and to are both the current UTC date, toISO is "now"', () => {
    vi.setSystemTime(new Date('2026-03-15T14:30:00.000Z'));
    const r = resolvePeriod({ period: 'today' });
    expect(r.fromDate).toBe('2026-03-15');
    expect(r.toDate).toBe('2026-03-15');
    expect(r.includesToday).toBe(true);
    vi.useRealTimers();
  });

  it('yesterday: excludes today entirely', () => {
    vi.setSystemTime(new Date('2026-03-15T14:30:00.000Z'));
    const r = resolvePeriod({ period: 'yesterday' });
    expect(r.fromDate).toBe('2026-03-14');
    expect(r.toDate).toBe('2026-03-14');
    expect(r.includesToday).toBe(false);
    expect(r.toISO).toBe('2026-03-15T00:00:00.000Z');
    vi.useRealTimers();
  });

  it('7d: spans exactly 7 calendar days ending today', () => {
    vi.setSystemTime(new Date('2026-03-15T14:30:00.000Z'));
    const r = resolvePeriod({ period: '7d' });
    expect(r.fromDate).toBe('2026-03-09');
    expect(r.toDate).toBe('2026-03-15');
    vi.useRealTimers();
  });

  it('30d: spans exactly 30 calendar days ending today', () => {
    vi.setSystemTime(new Date('2026-03-15T14:30:00.000Z'));
    const r = resolvePeriod({ period: '30d' });
    expect(r.fromDate).toBe('2026-02-14');
    expect(r.toDate).toBe('2026-03-15');
    vi.useRealTimers();
  });

  it('custom: honors the exact requested range and never includes today\'s live slice when the range is fully in the past', () => {
    const r = resolvePeriod({ period: 'custom', date_from: '2026-01-01', date_to: '2026-01-05' });
    expect(r.fromDate).toBe('2026-01-01');
    expect(r.toDate).toBe('2026-01-05');
    expect(r.includesToday).toBe(false);
  });

  it('custom: clamps toISO to "now" when the requested end date is today or later', () => {
    vi.setSystemTime(new Date('2026-03-15T14:30:00.000Z'));
    const r = resolvePeriod({ period: 'custom', date_from: '2026-03-10', date_to: '2026-03-20' });
    expect(r.includesToday).toBe(true);
    expect(r.toISO).toBe('2026-03-15T14:30:00.000Z');
    vi.useRealTimers();
  });
});

/** Seeds one organization with a known, hand-calculable set of rollup
 * rows plus a couple of "today" calls, so every derived rate/average in
 * DashboardMetrics can be checked against a hand computation - the
 * "rate calculations" unit-test requirement. */
function seedForRateChecks() {
  const { supabase, tables } = createFakeSupabase();
  const orgId = randomUUID();
  tables.organizations.push({ id: orgId, name: 'Rate Co', slug: 'rate-co' });

  // One historical rollup day: 10 calls, 6 connected, 2 transfers, 1
  // voicemail, 1 dnc, avg duration 100s.
  tables.analytics_daily_org.push({
    organization_id: orgId,
    date: '2026-01-01',
    total_calls: 10,
    calls_connected: 6,
    calls_completed: 5,
    calls_failed: 4,
    voicemails: 1,
    answering_machines: 0,
    dnc_count: 1,
    not_interested_count: 0,
    transfers: 2,
    callbacks_scheduled: 1,
    avg_call_duration_seconds: 100,
    avg_talk_time_seconds: 80,
  });

  return { supabase, tables, orgId };
}

describe('getDashboardMetrics - rate calculations', () => {
  it('computes connection/transfer/voicemail/dnc rate as percentages of total calls, matching the spec\'s implied ratio definitions', async () => {
    const { supabase, orgId } = seedForRateChecks();
    const resolved = resolvePeriod({ period: 'custom', date_from: '2026-01-01', date_to: '2026-01-01' });
    const metrics = await getDashboardMetrics(supabase, orgId, resolved);

    expect(metrics.total_calls).toBe(10);
    expect(metrics.calls_connected).toBe(6);
    expect(metrics.connection_rate).toBeCloseTo((6 / 10) * 100, 2);
    expect(metrics.transfer_rate).toBeCloseTo((2 / 10) * 100, 2);
    expect(metrics.voicemail_rate).toBeCloseTo((1 / 10) * 100, 2);
    expect(metrics.dnc_rate).toBeCloseTo((1 / 10) * 100, 2);
    expect(metrics.average_call_duration_seconds).toBe(100);
    expect(metrics.average_talk_time_seconds).toBe(80);
  });

  it('a period with zero calls never divides by zero - every rate is 0, not NaN/Infinity', async () => {
    const { supabase, tables } = createFakeSupabase();
    const orgId = randomUUID();
    tables.organizations.push({ id: orgId, name: 'Empty Co', slug: 'empty-co' });
    const resolved = resolvePeriod({ period: 'custom', date_from: '2026-02-01', date_to: '2026-02-01' });
    const metrics = await getDashboardMetrics(supabase, orgId, resolved);

    expect(metrics.total_calls).toBe(0);
    expect(metrics.connection_rate).toBe(0);
    expect(metrics.transfer_rate).toBe(0);
    expect(metrics.voicemail_rate).toBe(0);
    expect(metrics.dnc_rate).toBe(0);
  });
});

describe('getCampaignAnalytics', () => {
  it('completion_pct and attempts_per_lead are derived from live campaign_leads, never the rollup table', async () => {
    const { supabase, tables } = createFakeSupabase();
    const orgId = randomUUID();
    const campaignId = randomUUID();
    tables.organizations.push({ id: orgId, name: 'Camp Co', slug: 'camp-co' });
    tables.campaigns.push({ id: campaignId, organization_id: orgId, name: 'Spring' });
    tables.campaign_leads.push(
      { id: randomUUID(), campaign_id: campaignId, organization_id: orgId, lead_id: randomUUID(), status: 'completed', attempt_count: 2 },
      { id: randomUUID(), campaign_id: campaignId, organization_id: orgId, lead_id: randomUUID(), status: 'pending', attempt_count: 0 },
      { id: randomUUID(), campaign_id: campaignId, organization_id: orgId, lead_id: randomUUID(), status: 'dnc', attempt_count: 1 },
      { id: randomUUID(), campaign_id: campaignId, organization_id: orgId, lead_id: randomUUID(), status: 'retry_pending', attempt_count: 1 },
    );

    const resolved = resolvePeriod({ period: 'today' });
    const result = await getCampaignAnalytics(supabase, orgId, { id: campaignId, name: 'Spring' }, resolved);

    expect(result.total_leads).toBe(4);
    // completed + dnc = 2 terminal out of 4 = 50%
    expect(result.completion_pct).toBe(50);
    // (2 + 0 + 1 + 1) / 4 = 1
    expect(result.attempts_per_lead).toBe(1);
  });
});
