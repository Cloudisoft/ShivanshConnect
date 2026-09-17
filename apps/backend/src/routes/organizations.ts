import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError } from '../lib/errors.js';
import { updateOrganizationSchema } from '../schemas/organizations.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/me', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: org, error } = await supabase
      .from('organizations')
      .select('id, name, slug, timezone, status, created_at, updated_at')
      .eq('id', orgId)
      .maybeSingle();
    if (error) throw error;
    if (!org) throw new NotFoundError('Organization not found.');

    const { data: settings, error: settingsError } = await supabase
      .from('organization_settings')
      .select('settings')
      .eq('organization_id', orgId)
      .maybeSingle();
    if (settingsError) throw settingsError;

    return ok({ ...org, settings: settings?.settings ?? {} });
  });

  app.patch('/me', { preHandler: requirePermission('settings.manage') }, async (req) => {
    const body = updateOrganizationSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: before, error: beforeError } = await supabase
      .from('organizations')
      .select('id, name, timezone')
      .eq('id', orgId)
      .single();
    if (beforeError || !before) throw beforeError ?? new NotFoundError('Organization not found.');

    const orgPatch: Record<string, unknown> = {};
    if (body.name !== undefined) orgPatch.name = body.name;
    if (body.timezone !== undefined) orgPatch.timezone = body.timezone;

    if (Object.keys(orgPatch).length > 0) {
      const { error } = await supabase.from('organizations').update(orgPatch).eq('id', orgId);
      if (error) throw error;
    }

    if (body.settings !== undefined) {
      const { data: existingSettings } = await supabase
        .from('organization_settings')
        .select('settings')
        .eq('organization_id', orgId)
        .maybeSingle();

      const merged = { ...(existingSettings?.settings ?? {}), ...body.settings };
      const { error } = await supabase
        .from('organization_settings')
        .update({ settings: merged })
        .eq('organization_id', orgId);
      if (error) throw error;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.ORGANIZATION_SETTINGS_CHANGED,
      entityType: 'organization',
      entityId: orgId,
      oldValue: before,
      newValue: { ...orgPatch, settings: body.settings },
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase
      .from('organizations')
      .select('id, name, slug, timezone, status, created_at, updated_at')
      .eq('id', orgId)
      .single();
    const { data: settingsRow } = await supabase
      .from('organization_settings')
      .select('settings')
      .eq('organization_id', orgId)
      .maybeSingle();

    return ok({ ...updated, settings: settingsRow?.settings ?? {} }, { message: 'Organization updated.' });
  });
}
