import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { campaignSettingSchema, dialingSettingsSchema } from '../schemas/campaigns.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

/**
 * GET/PATCH /api/v1/dialing-settings - org-level defaults (spec section
 * 12). One default row per org, created lazily on first GET/PATCH so a
 * fresh org always has sane defaults without a separate seed step.
 *
 * GET/POST/PATCH /api/v1/campaigns/:id/settings - free-form per-campaign
 * overrides (campaign_settings key/value rows) that
 * services/campaignDispatcher.ts reads on top of the org defaults.
 */
export async function dialingSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    let { data: settings } = await supabase.from('dialing_settings').select('*').eq('organization_id', orgId).eq('is_default', true).maybeSingle();
    if (!settings) {
      const { data: created, error } = await supabase.from('dialing_settings').insert({ organization_id: orgId, is_default: true }).select('*').single();
      if (error) throw error;
      settings = created;
    }
    return ok(settings);
  });

  app.patch('/', { preHandler: requirePermission('settings.manage') }, async (req) => {
    const body = dialingSettingsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let { data: existing } = await supabase.from('dialing_settings').select('*').eq('organization_id', orgId).eq('is_default', true).maybeSingle();
    if (!existing) {
      const { data: created, error } = await supabase.from('dialing_settings').insert({ organization_id: orgId, is_default: true }).select('*').single();
      if (error) throw error;
      existing = created;
    }

    const { data: updated, error } = await supabase.from('dialing_settings').update(body).eq('id', existing.id).select('*').single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.DIALING_SETTINGS_UPDATED, entityType: 'dialing_settings', entityId: existing.id, oldValue: existing, newValue: updated, ipAddress: req.ip });
    return ok(updated, { message: 'Dialing settings updated.' });
  });
}

/** Registered under /campaigns/:id/settings - per-campaign dialing
 * overrides (campaign_settings key/value rows), e.g. AMD sensitivity,
 * retry policy overrides. */
export async function campaignSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  async function assertOwnedCampaign(id: string, orgId: string) {
    const supabase = getSupabaseAdmin();
    const { data: campaign } = await supabase.from('campaigns').select('id, organization_id').eq('id', id).maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new NotFoundError('Campaign not found.');
  }

  app.get('/:id/settings', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const orgId = req.user!.organizationId;
    await assertOwnedCampaign(id, orgId);
    const supabase = getSupabaseAdmin();
    const { data } = await supabase.from('campaign_settings').select('*').eq('campaign_id', id);
    return ok(data ?? []);
  });

  app.post('/:id/settings', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = campaignSettingSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    await assertOwnedCampaign(id, orgId);
    const supabase = getSupabaseAdmin();

    const { data: existing } = await supabase.from('campaign_settings').select('id').eq('campaign_id', id).eq('key', body.key).maybeSingle();
    let saved;
    if (existing) {
      const { data, error } = await supabase.from('campaign_settings').update({ value: body.value }).eq('id', existing.id).select('*').single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase.from('campaign_settings').insert({ campaign_id: id, organization_id: orgId, key: body.key, value: body.value }).select('*').single();
      if (error) throw error;
      saved = data;
    }

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.DIALING_SETTINGS_UPDATED, entityType: 'campaign_settings', entityId: saved.id, newValue: { key: body.key, value: body.value }, ipAddress: req.ip });
    return ok(saved, { message: 'Campaign setting saved.' });
  });
}
