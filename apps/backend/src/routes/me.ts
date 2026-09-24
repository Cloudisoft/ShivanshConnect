import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError } from '../lib/errors.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

const updateSelfSchema = z
  .object({
    full_name: z.string().trim().min(1).max(200).optional(),
    avatar_url: z.string().trim().url().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: authenticate }, async (req) => {
    const supabase = getSupabaseAdmin();
    const ctx = req.user!;

    // Called on every page load (the frontend's session bootstrap) - these
    // two lookups are fully independent, so they run in parallel rather
    // than paying two sequential round trips before the page can render.
    const [{ data: org, error: orgError }, { data: userRow, error: userError }] = await Promise.all([
      supabase.from('organizations').select('id, name, slug, timezone, status, created_at, updated_at').eq('id', ctx.organizationId).single(),
      supabase.from('users').select('id, organization_id, email, full_name, avatar_url, status, created_at, updated_at').eq('id', ctx.id).single(),
    ]);
    if (orgError || !org) throw new NotFoundError('Organization not found.');
    if (userError || !userRow) throw new NotFoundError('User not found.');

    return ok({
      user: userRow,
      organization: org,
      roles: ctx.roles,
      permissions: ctx.permissions,
    });
  });

  // Self-service profile edit (full name, avatar) - intentionally not
  // gated by the `users.manage` permission, since every authenticated
  // user may edit their own profile. Still scoped to their own id only.
  app.patch('/me', { preHandler: authenticate }, async (req) => {
    const body = updateSelfSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const ctx = req.user!;

    const patch: Record<string, unknown> = {};
    if (body.full_name !== undefined) patch.full_name = body.full_name;
    if (body.avatar_url !== undefined) patch.avatar_url = body.avatar_url;

    const { data: updated, error } = await supabase
      .from('users')
      .update(patch)
      .eq('id', ctx.id)
      .select('id, organization_id, email, full_name, avatar_url, status, created_at, updated_at')
      .single();
    if (error || !updated) throw error ?? new NotFoundError('User not found.');

    await writeAuditLog({
      organizationId: ctx.organizationId,
      userId: ctx.id,
      action: AUDIT_ACTIONS.USER_UPDATED,
      entityType: 'user',
      entityId: ctx.id,
      newValue: patch,
      ipAddress: req.ip,
    });

    return ok(updated, { message: 'Profile updated.' });
  });
}
