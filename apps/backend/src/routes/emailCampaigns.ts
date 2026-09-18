import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createEmailCampaignSchema, listEmailCampaignsQuerySchema, updateEmailCampaignSchema } from '../schemas/emailCampaigns.js';
import { listMessagesQuerySchema } from '../schemas/smsCampaigns.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, type MessagingCounts } from '@shivanshconnect/shared';
import { materializeEmailMessages } from '../services/emailDispatcher.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

async function getOwnedEmailCampaign(supabase: Supabase, id: string, orgId: string) {
  const { data, error } = await supabase.from('email_campaigns').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== orgId) throw new NotFoundError('Email campaign not found.');
  return data;
}

async function computeCounts(supabase: Supabase, campaignId: string): Promise<MessagingCounts> {
  const statuses = ['queued', 'sent', 'delivered', 'failed', 'replied'] as const;
  const counts: Record<string, number> = {};
  await Promise.all(
    statuses.map(async (status) => {
      const { count } = await supabase.from('email_messages').select('id', { count: 'exact', head: true }).eq('email_campaign_id', campaignId).eq('status', status);
      counts[status] = count ?? 0;
    }),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { queued: counts.queued, sent: counts.sent, delivered: counts.delivered, failed: counts.failed, replied: counts.replied, total };
}

export async function emailCampaignRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('messaging.manage'));

  app.get('/', async (req) => {
    const query = listEmailCampaignsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    let builder = supabase.from('email_campaigns').select('*', { count: 'exact' }).eq('organization_id', orgId);
    if (query.status) builder = builder.eq('status', query.status);
    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);
    const { data, error, count } = await builder;
    if (error) throw error;
    const withCounts = await Promise.all((data ?? []).map(async (c: any) => ({ ...c, counts: await computeCounts(supabase, c.id) })));
    return ok(withCounts, { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  app.post('/', async (req) => {
    const body = createEmailCampaignSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    if (body.recipient_lead_list_id) {
      const { data: list } = await supabase.from('lead_lists').select('id, organization_id').eq('id', body.recipient_lead_list_id).maybeSingle();
      if (!list || list.organization_id !== orgId) throw new NotFoundError('Lead list not found.');
    }
    if (body.recipient_filter?.campaign_id) {
      const { data: sourceCampaign } = await supabase.from('campaigns').select('id, organization_id').eq('id', body.recipient_filter.campaign_id).maybeSingle();
      if (!sourceCampaign || sourceCampaign.organization_id !== orgId) throw new NotFoundError('Source campaign not found.');
    }

    const { data: campaign, error } = await supabase
      .from('email_campaigns')
      .insert({ organization_id: orgId, status: 'draft', created_by: req.user!.id, ...body })
      .select('*')
      .single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_CREATED, entityType: 'email_campaign', entityId: campaign.id, newValue: { name: campaign.name }, ipAddress: req.ip });
    return ok(campaign, { message: 'Email campaign created.' });
  });

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedEmailCampaign(supabase, id, orgId);
    const counts = await computeCounts(supabase, id);
    return ok({ ...campaign, counts });
  });

  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateEmailCampaignSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const existing = await getOwnedEmailCampaign(supabase, id, orgId);
    if (existing.status === 'sending') throw new ValidationError('Pause this campaign before editing it.');

    const { data: updated, error } = await supabase.from('email_campaigns').update(body).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_UPDATED, entityType: 'email_campaign', entityId: id, oldValue: existing, newValue: updated, ipAddress: req.ip });
    return ok(updated, { message: 'Email campaign updated.' });
  });

  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const existing = await getOwnedEmailCampaign(supabase, id, orgId);
    if (!['draft', 'completed', 'cancelled', 'failed'].includes(existing.status)) {
      throw new ValidationError('Only a draft, completed, cancelled, or failed campaign can be deleted.');
    }
    const { error } = await supabase.from('email_campaigns').delete().eq('id', id);
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_DELETED, entityType: 'email_campaign', entityId: id, oldValue: existing, ipAddress: req.ip });
    return ok({ deleted: true }, { message: 'Email campaign deleted.' });
  });

  app.post('/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedEmailCampaign(supabase, id, orgId);
    if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
      throw new ValidationError(`Campaign cannot be started from status "${campaign.status}".`);
    }
    const { data: smtp } = await supabase.from('smtp_settings').select('id').eq('organization_id', orgId).maybeSingle();
    if (!smtp) throw new ValidationError('SMTP is not configured yet. Configure it under Settings before sending email campaigns.');

    if (campaign.status !== 'paused') {
      const materialized = await materializeEmailMessages(supabase, campaign);
      if (materialized === 0) {
        const { count } = await supabase.from('email_messages').select('id', { count: 'exact', head: true }).eq('email_campaign_id', id);
        if ((count ?? 0) === 0) throw new ValidationError('This campaign has no eligible recipients (empty list/filter, no email addresses, or every address has opted out).');
      }
    }

    const { data: updated, error } = await supabase.from('email_campaigns').update({ status: 'sending' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_STARTED, entityType: 'email_campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Email campaign started.' });
  });

  app.post('/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedEmailCampaign(supabase, id, orgId);
    if (campaign.status !== 'sending') throw new ValidationError('Only a sending campaign can be paused.');
    const { data: updated, error } = await supabase.from('email_campaigns').update({ status: 'paused' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_PAUSED, entityType: 'email_campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Email campaign paused.' });
  });

  app.post('/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedEmailCampaign(supabase, id, orgId);
    if (campaign.status !== 'paused') throw new ValidationError('Only a paused campaign can be resumed.');
    const { data: updated, error } = await supabase.from('email_campaigns').update({ status: 'sending' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_RESUMED, entityType: 'email_campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Email campaign resumed.' });
  });

  app.post('/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedEmailCampaign(supabase, id, orgId);
    if (!['sending', 'paused', 'scheduled', 'draft'].includes(campaign.status)) {
      throw new ValidationError('This campaign cannot be cancelled from its current status.');
    }
    const { data: updated, error } = await supabase.from('email_campaigns').update({ status: 'cancelled' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_CANCELLED, entityType: 'email_campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Email campaign cancelled.' });
  });

  app.get('/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const query = listMessagesQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedEmailCampaign(supabase, id, orgId);

    let builder = supabase.from('email_messages').select('*', { count: 'exact' }).eq('email_campaign_id', id);
    if (query.status) builder = builder.eq('status', query.status);
    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);
    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });
}
