/**
 * Phase 12: GET /api/v1/analytics/campaigns/:id, GET /api/v1/analytics/agents
 * - master spec section 42's Campaign Analytics / AI Agent KPI comparison.
 * Both delegate to services/analyticsQuery.ts, same as routes/dashboard.ts.
 */
import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { periodQuerySchema } from '../schemas/analytics.js';
import { getAgentAnalytics, getCampaignAnalytics, resolvePeriod } from '../services/analyticsQuery.js';

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('analytics.view'));

  // GET /api/v1/analytics/campaigns/:id
  app.get('/campaigns/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const query = periodQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: campaign, error } = await supabase.from('campaigns').select('id, name, organization_id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!campaign || campaign.organization_id !== orgId) throw new NotFoundError('Campaign not found.');

    const resolved = resolvePeriod(query);
    const analytics = await getCampaignAnalytics(supabase, orgId, campaign, resolved);
    return ok(analytics);
  });

  // GET /api/v1/analytics/agents
  app.get('/agents', async (req) => {
    const query = periodQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const resolved = resolvePeriod(query);
    const analytics = await getAgentAnalytics(supabase, orgId, resolved);
    return ok(analytics);
  });
}
