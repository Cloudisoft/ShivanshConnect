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
 * 15s, served stale (while refreshing in the background) for up to 10
 * minutes - so after the first load, every dashboard visit is instant. */
const metricsCache = new SwrCache<unknown>(15_000, 10 * 60_000);
const chartsCache = new SwrCache<unknown>(15_000, 10 * 60_000);

function cacheKey(orgId: string, query: PeriodQuery): string {
  return `${orgId}|${query.period}|${query.date_from ?? ''}|${query.date_to ?? ''}`;
}

/** Called right after sign-in (GET /me) so the first dashboard load after
 * login is already computed. Never throws. */
export function warmDashboard(orgId: string): void {
  const query: PeriodQuery = { period: 'today' };
  const supabase = getSupabaseAdmin();
  const key = cacheKey(orgId, query);
  void metricsCache.get(key, () => getDashboardMetrics(supabase, orgId, resolvePeriod(query))).catch(() => undefined);
  void chartsCache.get(key, () => getDashboardCharts(supabase, orgId, resolvePeriod(query))).catch(() => undefined);
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
