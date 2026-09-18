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

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/dashboard
  app.get('/', { preHandler: requirePermission('analytics.view') }, async (req) => {
    const query = periodQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const resolved = resolvePeriod(query);
    const metrics = await getDashboardMetrics(supabase, orgId, resolved);
    return ok(metrics);
  });

  // GET /api/v1/dashboard/charts
  app.get('/charts', { preHandler: requirePermission('analytics.view') }, async (req) => {
    const query = periodQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const resolved = resolvePeriod(query);
    const charts = await getDashboardCharts(supabase, orgId, resolved);
    return ok(charts);
  });
}
