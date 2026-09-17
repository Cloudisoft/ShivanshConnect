import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { listAuditLogsQuerySchema } from '../schemas/audit.js';

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { preHandler: [authenticate, requirePermission('audit.view')] },
    async (req) => {
      const query = listAuditLogsQuerySchema.parse(req.query);
      const supabase = getSupabaseAdmin();
      const orgId = req.user!.organizationId;

      let builder = supabase
        .from('audit_logs')
        .select('id, organization_id, user_id, action, entity_type, entity_id, old_value, new_value, ip_address, created_at', {
          count: 'exact',
        })
        .eq('organization_id', orgId);

      if (query.user_id) builder = builder.eq('user_id', query.user_id);
      if (query.action) builder = builder.eq('action', query.action);
      if (query.from) builder = builder.gte('created_at', query.from);
      if (query.to) builder = builder.lte('created_at', query.to);

      const from = (query.page - 1) * query.page_size;
      const to = from + query.page_size - 1;
      builder = builder.order('created_at', { ascending: false }).range(from, to);

      const { data, error, count } = await builder;
      if (error) throw error;

      return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
    },
  );
}
