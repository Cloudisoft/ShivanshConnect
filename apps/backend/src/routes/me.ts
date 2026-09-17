import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError } from '../lib/errors.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: authenticate }, async (req) => {
    const supabase = getSupabaseAdmin();
    const ctx = req.user!;

    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, name, slug, timezone, status, created_at, updated_at')
      .eq('id', ctx.organizationId)
      .single();
    if (orgError || !org) throw new NotFoundError('Organization not found.');

    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('id, organization_id, email, full_name, avatar_url, status, created_at, updated_at')
      .eq('id', ctx.id)
      .single();
    if (userError || !userRow) throw new NotFoundError('User not found.');

    return ok({
      user: userRow,
      organization: org,
      roles: ctx.roles,
      permissions: ctx.permissions,
    });
  });
}
