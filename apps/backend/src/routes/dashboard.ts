/**
 * Phase 12: GET /api/v1/dashboard, GET /api/v1/dashboard/charts - master
 * spec section 6's dashboard KPI grid + chart set. Both routes delegate
 * every real computation to services/analyticsQuery.ts (the shared
 * query-building module both this file and routes/analytics.ts use -
 * same "one place, never duplicated" pattern as Phase 9's cdrQuery.ts).
 */
import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { periodQuerySchema } from '../schemas/analytics.js';
import { getDashboardCharts, getDashboardMetrics, resolvePeriod } from '../services/analyticsQuery.js';
import { SwrCache } from '../lib/swrCache.js';
import type { PeriodQuery } from '../schemas/analytics.js';

/** Dashboard KPIs/charts are aggregates over many rows; a few seconds of
 * staleness is fine (live calls stream through Live Monitor). Fresh for
 * 15s, and otherwise served immediately while a refresh runs in the
 * background (for up to a day). startDashboardWarmer() below keeps every
 * organization's "today" view pre-computed, so even the first sign-in of
 * the day never waits for the dashboard to be built. */
const metricsCache = new SwrCache<unknown>(15_000, 24 * 60 * 60_000);
const chartsCache = new SwrCache<unknown>(15_000, 24 * 60 * 60_000);

/** How often the warmer rebuilds each organization's "today" dashboard. */
const WARM_INTERVAL_MS = Number.parseInt(process.env.DASHBOARD_WARM_INTERVAL_MS ?? '', 10) || 30_000;
/** Beyond this many organizations only recently active ones are kept warm. */
const WARM_ALL_ORGS_LIMIT = 50;
const recentlyActiveOrgs = new Map<string, number>();

function cacheKey(orgId: string, query: PeriodQuery): string {
  return `${orgId}|${query.period}|${query.date_from ?? ''}|${query.date_to ?? ''}`;
}

/** Called right after sign-in (GET /me) so the first dashboard load after
 * login is already computed. Never throws. */
export function warmDashboard(orgId: string): void {
  recentlyActiveOrgs.set(orgId, Date.now());
  const query: PeriodQuery = { period: 'today' };
  const supabase = getSupabaseAdmin();
  const key = cacheKey(orgId, query);
  void metricsCache.get(key, () => getDashboardMetrics(supabase, orgId, resolvePeriod(query))).catch(() => undefined);
  void chartsCache.get(key, () => getDashboardCharts(supabase, orgId, resolvePeriod(query))).catch(() => undefined);
}

/** Rebuilds one organization's "today" dashboard in the background. */
async function rebuildToday(orgId: string): Promise<void> {
  const query: PeriodQuery = { period: 'today' };
  const supabase = getSupabaseAdmin();
  const key = cacheKey(orgId, query);
  await Promise.all([
    metricsCache.refresh(key, () => getDashboardMetrics(supabase, orgId, resolvePeriod(query))),
    chartsCache.refresh(key, () => getDashboardCharts(supabase, orgId, resolvePeriod(query))),
  ]);
}

let warmerHandle: ReturnType<typeof setInterval> | null = null;
let warmerRunning = false;

/** Keeps the dashboard pre-computed: at boot and every WARM_INTERVAL_MS it
 * rebuilds "today" for every active organization (or, past
 * WARM_ALL_ORGS_LIMIT organizations, those seen in the last day). One
 * organization at a time, so it never loads the database in bursts. */
export function startDashboardWarmer(): void {
  if (warmerHandle) return;
  const tick = async () => {
    if (warmerRunning) return;
    warmerRunning = true;
    try {
      const supabase = getSupabaseAdmin();
      const { data } = await supabase.from('organizations').select('id').in('status', ['active', 'trial']).limit(WARM_ALL_ORGS_LIMIT + 1);
      const dayAgo = Date.now() - 24 * 60 * 60_000;
      for (const [orgId, seenAt] of recentlyActiveOrgs) if (seenAt < dayAgo) recentlyActiveOrgs.delete(orgId);
      const orgIds =
        data && data.length <= WARM_ALL_ORGS_LIMIT ? data.map((o: { id: string }) => o.id) : [...recentlyActiveOrgs.keys()];
      for (const orgId of orgIds) {
        await rebuildToday(orgId).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('dashboard warmer failed for org', orgId, err);
        });
      }
    } finally {
      warmerRunning = false;
    }
  };
  void tick();
  warmerHandle = setInterval(() => void tick(), WARM_INTERVAL_MS);
  if (typeof warmerHandle.unref === 'function') warmerHandle.unref();
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/dashboard
  app.get('/', { preHandler: requirePermission('analytics.view') }, async (req) => {
    const query = periodQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const metrics = await metricsCache.get(cacheKey(orgId, query), () => getDashboardMetrics(supabase, orgId, resolvePeriod(query)));
    return ok(metrics);
  });

  // GET /api/v1/dashboard/charts
  app.get('/charts', { preHandler: requirePermission('analytics.view') }, async (req) => {
    const query = periodQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const charts = await chartsCache.get(cacheKey(orgId, query), () => getDashboardCharts(supabase, orgId, resolvePeriod(query)));
    return ok(charts);
  });
}
