/**
 * Phase 12: the analytics rollup aggregator (master spec section 89 -
 * pre-aggregate, never compute expensive historical analytics from raw
 * events at request time). Same in-process `setInterval` pattern Phase
 * 7's campaign dispatcher established (services/campaignDispatcher.ts's
 * header comment explains why - no Redis/BullMQ until Phase 15) -
 * `runAggregationTick()` is what a real repeatable job would call
 * instead of this module's own timer.
 *
 * What each tick does, per organization:
 *   1. TODAY's row is always recomputed (`recompute_analytics_daily_org`/
 *      `_campaign`/`_agent` for today's date, `recompute_analytics_hourly_org`
 *      for the current hour) - documented choice: rather than trying to
 *      incrementally patch today's row on every call event, it's simply
 *      recomputed wholesale every tick (every 5 minutes by default), which
 *      is cheap (one day's worth of calls, real SQL aggregates) and can
 *      never drift out of sync with the authoritative tables.
 *   2. ONE-TIME BACKFILL: if this organization has no historical rollup
 *      row (any analytics_daily_org row with date < today) AND it has
 *      calls older than today, every distinct historical date present in
 *      `calls` is recomputed once. This is naturally idempotent (the
 *      recompute functions upsert), and naturally "one-time" because the
 *      presence check above stops finding a reason to run it again once
 *      at least one historical row exists - no separate persisted
 *      "backfill done" flag needed.
 *
 * A tick-overlap guard mirrors the dispatcher's `tickInFlight`. A
 * per-organization failure is logged and skipped, never allowed to stall
 * every other organization's aggregation.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const AGGREGATION_TICK_MS = Number.parseInt(process.env.ANALYTICS_AGGREGATION_INTERVAL_MS ?? '', 10) || 5 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function distinctHistoricalDates(supabase: Supabase, orgId: string, beforeDate: string): Promise<string[]> {
  const { data } = await supabase.from('calls').select('created_at').eq('organization_id', orgId).lt('created_at', `${beforeDate}T00:00:00.000Z`);
  const dates = new Set<string>();
  for (const row of (data as Array<{ created_at: string }>) ?? []) {
    dates.add(row.created_at.slice(0, 10));
  }
  return [...dates].sort();
}

async function backfillOrgIfNeeded(supabase: Supabase, orgId: string, todayDate: string): Promise<void> {
  const { count: historicalRowCount } = await supabase
    .from('analytics_daily_org')
    .select('date', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .lt('date', todayDate);
  if ((historicalRowCount ?? 0) > 0) return; // already backfilled at least once

  const dates = await distinctHistoricalDates(supabase, orgId, todayDate);
  for (const date of dates) {
    // eslint-disable-next-line no-await-in-loop
    await supabase.rpc('recompute_analytics_daily_org', { p_org_id: orgId, p_date: date });
    // eslint-disable-next-line no-await-in-loop
    await supabase.rpc('recompute_analytics_daily_campaign', { p_org_id: orgId, p_date: date });
    // eslint-disable-next-line no-await-in-loop
    await supabase.rpc('recompute_analytics_daily_agent', { p_org_id: orgId, p_date: date });
  }
}

async function backfillHourlyIfNeeded(supabase: Supabase, orgId: string, currentHourIso: string): Promise<void> {
  const { count: historicalHourCount } = await supabase
    .from('analytics_hourly_org')
    .select('hour_bucket', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .lt('hour_bucket', currentHourIso);
  if ((historicalHourCount ?? 0) > 0) return;

  const { data } = await supabase.from('calls').select('created_at').eq('organization_id', orgId).lt('created_at', currentHourIso);
  const hours = new Set<string>();
  for (const row of (data as Array<{ created_at: string }>) ?? []) {
    const bucket = new Date(row.created_at);
    bucket.setUTCMinutes(0, 0, 0);
    hours.add(bucket.toISOString());
  }
  for (const hourIso of [...hours].sort()) {
    // eslint-disable-next-line no-await-in-loop
    await supabase.rpc('recompute_analytics_hourly_org', { p_org_id: orgId, p_hour: hourIso });
  }
}

async function processOrganization(supabase: Supabase, orgId: string): Promise<void> {
  const now = new Date();
  const todayDate = utcDateStr(now);
  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);
  const currentHourIso = currentHour.toISOString();

  await backfillOrgIfNeeded(supabase, orgId, todayDate);
  await backfillHourlyIfNeeded(supabase, orgId, currentHourIso);

  // Always recompute today's / this hour's row, every tick.
  await supabase.rpc('recompute_analytics_daily_org', { p_org_id: orgId, p_date: todayDate });
  await supabase.rpc('recompute_analytics_daily_campaign', { p_org_id: orgId, p_date: todayDate });
  await supabase.rpc('recompute_analytics_daily_agent', { p_org_id: orgId, p_date: todayDate });
  await supabase.rpc('recompute_analytics_hourly_org', { p_org_id: orgId, p_hour: currentHourIso });
}

/** One aggregation pass over every organization. Never throws - a
 * per-organization failure is logged and the loop continues. */
export async function runAggregationTick(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: orgs, error } = await supabase.from('organizations').select('id');
  if (error) throw error;

  for (const org of (orgs as Array<{ id: string }>) ?? []) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await processOrganization(supabase, org.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Analytics aggregation failed for organization', org.id, err);
    }
  }
}

/** Starts the in-process aggregation loop - same shape as
 * services/campaignDispatcher.ts's startCampaignDispatcher(). */
export function startAnalyticsAggregator(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    runAggregationTick()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Analytics aggregation tick failed', err);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, AGGREGATION_TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  // Kick off an immediate first tick (not just on the first interval
  // firing 5 minutes later) so a freshly-started backend with existing
  // historical data doesn't leave the dashboard looking empty for 5
  // minutes - mirrors the dispatcher's "start dialing right away" intent.
  if (tickInFlight) return;
  tickInFlight = true;
  runAggregationTick()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Analytics aggregation initial tick failed', err);
    })
    .finally(() => {
      tickInFlight = false;
    });
}

/** Test-only escape hatch. */
export function _resetAnalyticsAggregatorForTests(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  tickInFlight = false;
}
