import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';

/** GET /api/v1/permissions - the full permission catalog, for the role editor UI. */
export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { preHandler: [authenticate, requirePermission('roles.manage')] },
    async () => {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from('permissions')
        .select('id, key, description, category')
        .order('category', { ascending: true })
        .order('key', { ascending: true });
      if (error) throw error;
      return ok(data ?? []);
    },
  );
}
