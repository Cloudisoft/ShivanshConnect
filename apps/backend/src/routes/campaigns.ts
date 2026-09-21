import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import {
  attachLeadsSchema,
  createCampaignSchema,
  createCampaignVersionSchema,
  listCampaignsQuerySchema,
  rotateLeadsSchema,
  updateCampaignSchema,
  updateConcurrencySchema,
} from '../schemas/campaigns.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, CAMPAIGN_LEAD_STATUSES, type CampaignCallingRulesSnapshot, type CampaignDispositionRulesSnapshot } from '@shivanshconnect/shared';
import { runCampaignPreflight } from '../services/campaignPreflight.js';
import { decideRotation } from '../services/campaignRotate.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

async function getOwnedCampaign(supabase: Supabase, id: string, orgId: string) {
  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!campaign || campaign.organization_id !== orgId) throw new NotFoundError('Campaign not found.');
  return campaign;
}

async function computeCampaignCounts(supabase: Supabase, campaignId: string) {
  const counts: Record<string, number> = {};
  await Promise.all(
    CAMPAIGN_LEAD_STATUSES.map(async (status) => {
      const { count } = await supabase.from('campaign_leads').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', status);
      counts[status] = count ?? 0;
    }),
  );
  const { count: total } = await supabase.from('campaign_leads').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
  const { count: activeCalls } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['queued', 'dialing', 'ringing', 'answered', 'in_progress', 'voicemail', 'answering_machine', 'transfer_pending', 'transferring']);
  return {
    total: total ?? 0,
    pending: counts.pending ?? 0,
    queued: counts.queued ?? 0,
    dialing: counts.dialing ?? 0,
    in_progress: counts.in_progress ?? 0,
    connected: counts.connected ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    retry_pending: counts.retry_pending ?? 0,
    skipped: counts.skipped ?? 0,
    dnc: counts.dnc ?? 0,
    active_calls: activeCalls ?? 0,
  };
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/campaigns
  app.get('/', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const query = listCampaignsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('campaigns').select('*', { count: 'exact' }).eq('organization_id', orgId);
    if (query.status) builder = builder.eq('status', query.status);
    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;

    const withCounts = await Promise.all((data ?? []).map(async (c: any) => ({ ...c, counts: await computeCampaignCounts(supabase, c.id) })));
    return ok(withCounts, { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // POST /api/v1/campaigns - always created as draft.
  app.post('/', { preHandler: requirePermission('campaigns.create') }, async (req) => {
    const body = createCampaignSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .insert({ organization_id: orgId, status: 'draft', created_by: req.user!.id, ...body })
      .select('*')
      .single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_CREATED, entityType: 'campaign', entityId: campaign.id, newValue: { name: campaign.name }, ipAddress: req.ip });

    return ok(campaign, { message: 'Campaign created.' });
  });

  // GET /api/v1/campaigns/:id - full detail with live counts.
  app.get('/:id', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);
    const counts = await computeCampaignCounts(supabase, id);

    let currentVersion = null;
    if (campaign.current_version_id) {
      const { data } = await supabase.from('campaign_versions').select('*').eq('id', campaign.current_version_id).maybeSingle();
      currentVersion = data;
    }

    return ok({ ...campaign, counts, current_version: currentVersion });
  });

  // PATCH /api/v1/campaigns/:id
  app.patch('/:id', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateCampaignSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const existing = await getOwnedCampaign(supabase, id, orgId);
    if (existing.status === 'running') {
      throw new ValidationError('Pause this campaign before editing its configuration.');
    }

    const { data: updated, error } = await supabase.from('campaigns').update(body).eq('id', id).select('*').single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_UPDATED, entityType: 'campaign', entityId: id, oldValue: existing, newValue: updated, ipAddress: req.ip });
    return ok(updated, { message: 'Campaign updated.' });
  });

  // DELETE /api/v1/campaigns/:id - only draft/archived campaigns.
  app.delete('/:id', { preHandler: requirePermission('campaigns.delete') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const existing = await getOwnedCampaign(supabase, id, orgId);
    if (!['draft', 'archived', 'stopped', 'completed', 'failed'].includes(existing.status)) {
      throw new ValidationError('Only draft, stopped, completed, failed, or archived campaigns can be deleted.');
    }
    const { error } = await supabase.from('campaigns').delete().eq('id', id);
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_DELETED, entityType: 'campaign', entityId: id, oldValue: existing, ipAddress: req.ip });
    return ok({ deleted: true }, { message: 'Campaign deleted.' });
  });

  // POST /api/v1/campaigns/:id/duplicate - clones config into a new draft.
  app.post('/:id/duplicate', { preHandler: requirePermission('campaigns.create') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const existing = await getOwnedCampaign(supabase, id, orgId);

    const { data: duplicate, error } = await supabase
      .from('campaigns')
      .insert({
        organization_id: orgId,
        name: `${existing.name} (copy)`,
        description: existing.description,
        status: 'draft',
        timezone: existing.timezone,
        calling_window_start: existing.calling_window_start,
        calling_window_end: existing.calling_window_end,
        calling_days: existing.calling_days,
        start_date: null,
        end_date: null,
        concurrency_limit: existing.concurrency_limit,
        calls_per_minute_limit: existing.calls_per_minute_limit,
        phone_number_id: existing.phone_number_id,
        transfer_number_e164: existing.transfer_number_e164,
        voicemail_detection_enabled: existing.voicemail_detection_enabled,
        voicemail_message: existing.voicemail_message,
        leave_voicemail: existing.leave_voicemail,
        lead_cooldown_minutes: existing.lead_cooldown_minutes,
        background_noise: existing.background_noise,
        created_by: req.user!.id,
      })
      .select('*')
      .single();
    if (error) throw error;

    if (existing.current_version_id) {
      const { data: sourceVersion } = await supabase.from('campaign_versions').select('*').eq('id', existing.current_version_id).maybeSingle();
      if (sourceVersion) {
        await supabase.from('campaign_versions').insert({
          campaign_id: duplicate.id,
          organization_id: orgId,
          version_number: 1,
          prompt: sourceVersion.prompt,
          ai_agent_id: sourceVersion.ai_agent_id,
          ai_agent_version_id: null, // re-resolved live on next publish, not carried over as a stale snapshot
          voice_id: sourceVersion.voice_id,
          knowledge_base_ids: sourceVersion.knowledge_base_ids,
          script_id: sourceVersion.script_id,
          transfer_number_e164: sourceVersion.transfer_number_e164,
          calling_rules: sourceVersion.calling_rules,
          disposition_rules: sourceVersion.disposition_rules,
          status: 'draft',
          created_by: req.user!.id,
        });
      }
    }
    // Leads/progress are deliberately NOT cloned - see the endpoint's doc comment.

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_DUPLICATED, entityType: 'campaign', entityId: duplicate.id, oldValue: { source_campaign_id: id }, ipAddress: req.ip });
    return ok(duplicate, { message: 'Campaign duplicated as a new draft.' });
  });

  // POST /api/v1/campaigns/:id/versions - create/edit a draft version.
  app.post('/:id/versions', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = createCampaignVersionSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);

    const { data: dialingSettings } = await supabase.from('dialing_settings').select('*').eq('organization_id', orgId).eq('is_default', true).maybeSingle();

    const callingRules: CampaignCallingRulesSnapshot = {
      timezone: body.calling_rules.timezone ?? campaign.timezone,
      calling_window_start: body.calling_rules.calling_window_start ?? campaign.calling_window_start,
      calling_window_end: body.calling_rules.calling_window_end ?? campaign.calling_window_end,
      calling_days: body.calling_rules.calling_days ?? campaign.calling_days,
      lead_cooldown_minutes: body.calling_rules.lead_cooldown_minutes ?? campaign.lead_cooldown_minutes,
      voicemail_detection_enabled: body.calling_rules.voicemail_detection_enabled ?? campaign.voicemail_detection_enabled,
      voicemail_message: body.calling_rules.voicemail_message ?? campaign.voicemail_message,
      leave_voicemail: body.calling_rules.leave_voicemail ?? campaign.leave_voicemail,
      background_noise: body.calling_rules.background_noise ?? campaign.background_noise,
    };
    const dispositionRules: CampaignDispositionRulesSnapshot = {
      retry_on: body.disposition_rules.retry_on ?? ['no-answer', 'busy', 'customer-did-not-answer'],
      max_attempts: body.disposition_rules.max_attempts ?? dialingSettings?.max_attempts ?? 3,
      retry_delay_minutes: body.disposition_rules.retry_delay_minutes ?? dialingSettings?.retry_delay_minutes ?? 60,
    };

    if (body.ai_agent_id) {
      const { data: agent } = await supabase.from('ai_agents').select('id, organization_id').eq('id', body.ai_agent_id).maybeSingle();
      if (!agent || agent.organization_id !== orgId) throw new NotFoundError('AI agent not found.');
    }
    if (body.voice_id) {
      const { data: voice } = await supabase.from('voices').select('id, organization_id').eq('id', body.voice_id).maybeSingle();
      if (!voice || voice.organization_id !== orgId) throw new NotFoundError('Voice not found.');
    }

    const { data: lastVersion } = await supabase
      .from('campaign_versions')
      .select('version_number')
      .eq('campaign_id', id)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersionNumber = (lastVersion?.version_number ?? 0) + 1;

    const { data: version, error } = await supabase
      .from('campaign_versions')
      .insert({
        campaign_id: id,
        organization_id: orgId,
        version_number: nextVersionNumber,
        prompt: body.prompt,
        ai_agent_id: body.ai_agent_id ?? null,
        ai_agent_version_id: null, // resolved at publish time - see publish handler
        voice_id: body.voice_id ?? null,
        knowledge_base_ids: body.knowledge_base_ids,
        script_id: body.script_id ?? null,
        transfer_number_e164: body.transfer_number_e164 ?? campaign.transfer_number_e164 ?? null,
        calling_rules: callingRules,
        disposition_rules: dispositionRules,
        status: 'draft',
        created_by: req.user!.id,
      })
      .select('*')
      .single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_VERSION_CREATED, entityType: 'campaign_version', entityId: version.id, newValue: { campaign_id: id, version_number: nextVersionNumber }, ipAddress: req.ip });
    return ok(version, { message: 'Campaign version created.' });
  });

  // POST /api/v1/campaigns/:id/versions/:versionId/publish - THE snapshot
  // step (spec 84/85). Locks in the agent's CURRENT published version id,
  // never re-resolved after this point even if the agent is later
  // re-published.
  app.post('/:id/versions/:versionId/publish', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(versionId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);

    const { data: version, error: versionError } = await supabase.from('campaign_versions').select('*').eq('id', versionId).maybeSingle();
    if (versionError) throw versionError;
    if (!version || version.campaign_id !== id) throw new NotFoundError('Campaign version not found.');
    if (version.status === 'published') throw new ConflictError('This version is already published.');

    let agentVersionId: string | null = null;
    if (version.ai_agent_id) {
      const { data: agent } = await supabase.from('ai_agents').select('id, current_version_id').eq('id', version.ai_agent_id).maybeSingle();
      if (!agent?.current_version_id) {
        throw new ValidationError('The selected AI agent has no published version - publish the agent first.');
      }
      agentVersionId = agent.current_version_id;
    }

    // Archive whatever was previously published for this campaign (never
    // rewrite it - immutable history, same pattern as ai_agent_versions).
    if (campaign.current_version_id) {
      await supabase.from('campaign_versions').update({ status: 'archived' }).eq('id', campaign.current_version_id);
    }

    const { data: published, error: publishError } = await supabase
      .from('campaign_versions')
      .update({ ai_agent_version_id: agentVersionId, status: 'published', published_at: new Date().toISOString() })
      .eq('id', versionId)
      .select('*')
      .single();
    if (publishError) throw publishError;

    const { data: updatedCampaign, error: campaignUpdateError } = await supabase
      .from('campaigns')
      .update({ current_version_id: versionId })
      .eq('id', id)
      .select('*')
      .single();
    if (campaignUpdateError) throw campaignUpdateError;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CAMPAIGN_VERSION_PUBLISHED,
      entityType: 'campaign_version',
      entityId: versionId,
      newValue: { campaign_id: id, ai_agent_version_id: agentVersionId, voice_id: version.voice_id },
      ipAddress: req.ip,
    });

    return ok({ campaign: updatedCampaign, version: published }, { message: 'Campaign version published - this configuration is now snapshotted and locked in.' });
  });

  // GET /api/v1/campaigns/:id/preflight
  app.get('/:id/preflight', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedCampaign(supabase, id, orgId);
    const result = await runCampaignPreflight(supabase, orgId, id);
    return ok(result);
  });

  // POST /api/v1/campaigns/:id/start
  app.post('/:id/start', { preHandler: requirePermission('campaigns.start') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);
    if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
      throw new ValidationError(`Campaign cannot be started from status "${campaign.status}".`);
    }

    const preflight = await runCampaignPreflight(supabase, orgId, id);
    if (!preflight.ready) {
      throw new ValidationError('Campaign is not ready to start.', { errors: preflight.errors });
    }

    const isFutureStart = campaign.start_date && new Date(campaign.start_date) > new Date();
    const nextStatus = isFutureStart ? 'scheduled' : 'running';

    const { data: updated, error } = await supabase.from('campaigns').update({ status: nextStatus }).eq('id', id).select('*').single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_STARTED, entityType: 'campaign', entityId: id, newValue: { status: nextStatus }, ipAddress: req.ip });
    return ok(updated, { message: nextStatus === 'running' ? 'Campaign started.' : 'Campaign scheduled to start.' });
  });

  // POST /api/v1/campaigns/:id/pause - resumable.
  app.post('/:id/pause', { preHandler: requirePermission('campaigns.pause') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);
    if (campaign.status !== 'running') throw new ValidationError('Only a running campaign can be paused.');

    const { data: updated, error } = await supabase.from('campaigns').update({ status: 'paused' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_PAUSED, entityType: 'campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Campaign paused.' });
  });

  // POST /api/v1/campaigns/:id/resume
  app.post('/:id/resume', { preHandler: requirePermission('campaigns.start') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);
    if (campaign.status !== 'paused') throw new ValidationError('Only a paused campaign can be resumed.');

    const preflight = await runCampaignPreflight(supabase, orgId, id);
    if (!preflight.ready) throw new ValidationError('Campaign is not ready to resume.', { errors: preflight.errors });

    const { data: updated, error } = await supabase.from('campaigns').update({ status: 'running' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_RESUMED, entityType: 'campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Campaign resumed.' });
  });

  // POST /api/v1/campaigns/:id/stop - terminal, not resumable.
  app.post('/:id/stop', { preHandler: requirePermission('campaigns.pause') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);
    if (!['running', 'paused', 'scheduled'].includes(campaign.status)) {
      throw new ValidationError('Only a running, paused, or scheduled campaign can be stopped.');
    }
    const { data: updated, error } = await supabase.from('campaigns').update({ status: 'stopped' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_STOPPED, entityType: 'campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Campaign stopped.' });
  });

  // POST /api/v1/campaigns/:id/archive
  app.post('/:id/archive', { preHandler: requirePermission('campaigns.delete') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);
    if (!['draft', 'stopped', 'completed', 'failed'].includes(campaign.status)) {
      throw new ValidationError('Only a draft, stopped, completed, or failed campaign can be archived.');
    }
    const { data: updated, error } = await supabase.from('campaigns').update({ status: 'archived' }).eq('id', id).select('*').single();
    if (error) throw error;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_ARCHIVED, entityType: 'campaign', entityId: id, ipAddress: req.ip });
    return ok(updated, { message: 'Campaign archived.' });
  });

  // PATCH /api/v1/campaigns/:id/concurrency - live adjustment, audited.
  app.patch('/:id/concurrency', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateConcurrencySchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);

    const { data: updated, error } = await supabase.from('campaigns').update({ concurrency_limit: body.concurrency_limit }).eq('id', id).select('*').single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CAMPAIGN_CONCURRENCY_CHANGED,
      entityType: 'campaign',
      entityId: id,
      oldValue: { concurrency_limit: campaign.concurrency_limit },
      newValue: { concurrency_limit: body.concurrency_limit },
      ipAddress: req.ip,
    });
    return ok(updated, { message: `Concurrency changed from ${campaign.concurrency_limit} to ${body.concurrency_limit}.` });
  });

  // POST /api/v1/campaigns/:id/leads - attach lead(s)/a lead list.
  app.post('/:id/leads', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = attachLeadsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedCampaign(supabase, id, orgId);

    let leadIds: string[] = body.lead_ids ?? [];
    if (body.lead_list_id) {
      const { data: list } = await supabase.from('lead_lists').select('id, organization_id').eq('id', body.lead_list_id).maybeSingle();
      if (!list || list.organization_id !== orgId) throw new NotFoundError('Lead list not found.');
      const { data: members } = await supabase.from('lead_list_members').select('lead_id').eq('lead_list_id', body.lead_list_id);
      leadIds = leadIds.concat((members ?? []).map((m: any) => m.lead_id));
    }
    leadIds = Array.from(new Set(leadIds));
    if (leadIds.length === 0) return ok({ attached: 0 }, { message: 'No leads to attach.' });

    // Only attach leads that actually belong to this org and are not on
    // the DNC list (never queue a suppressed lead in the first place).
    const { data: validLeads } = await supabase.from('leads').select('id, organization_id, is_dnc').in('id', leadIds);
    const ownLeadIds = (validLeads ?? []).filter((l: any) => l.organization_id === orgId).map((l: any) => l.id);

    const { data: existing } = await supabase.from('campaign_leads').select('lead_id').eq('campaign_id', id).in('lead_id', ownLeadIds);
    const existingIds = new Set((existing ?? []).map((r: any) => r.lead_id));
    const toInsert = (validLeads ?? [])
      .filter((l: any) => l.organization_id === orgId && !existingIds.has(l.id))
      .map((l: any) => ({
        campaign_id: id,
        organization_id: orgId,
        lead_id: l.id,
        status: l.is_dnc ? 'dnc' : 'pending',
        final_disposition: l.is_dnc ? 'dnc' : null,
      }));

    const BATCH_SIZE = 500;
    let attached = 0;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('campaign_leads').insert(batch);
      if (error) throw error;
      attached += batch.length;
    }

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_LEADS_ATTACHED, entityType: 'campaign', entityId: id, newValue: { attached }, ipAddress: req.ip });
    return ok({ attached }, { message: `${attached} lead(s) attached.` });
  });

  // GET /api/v1/campaigns/:id/leads
  app.get('/:id/leads', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const query = req.query as { page?: string; page_size?: string; status?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.page_size ?? '20', 10) || 20));
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedCampaign(supabase, id, orgId);

    let builder = supabase.from('campaign_leads').select('*, leads(id, first_name, last_name, phone_normalized)', { count: 'exact' }).eq('campaign_id', id);
    if (query.status) builder = builder.eq('status', query.status);
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    builder = builder.order('added_at', { ascending: false }).range(from, to);
    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(page, pageSize, count ?? 0) });
  });

  // POST /api/v1/campaigns/:id/leads/rotate - reuse/re-queue a worked list,
  // filtering per campaignRotate.ts's real inclusion/exclusion rule.
  app.post('/:id/leads/rotate', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = rotateLeadsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedCampaign(supabase, id, orgId);

    const { data: campaignLeads, error } = await supabase.from('campaign_leads').select('id, lead_id, status, final_disposition').eq('campaign_id', id);
    if (error) throw error;

    const decisions = decideRotation(campaignLeads ?? []);
    const included = decisions.filter((d) => d.include);
    const excluded = decisions.filter((d) => !d.include);

    if (!body.dry_run) {
      const BATCH_SIZE = 500;
      for (let i = 0; i < included.length; i += BATCH_SIZE) {
        const batch = included.slice(i, i + BATCH_SIZE);
        await supabase
          .from('campaign_leads')
          .update({ status: 'pending', attempt_count: 0, next_eligible_at: null, final_disposition: null })
          .in(
            'id',
            batch.map((b) => b.campaignLeadId),
          );
      }
      await writeAuditLog({
        organizationId: orgId,
        userId: req.user!.id,
        action: AUDIT_ACTIONS.CAMPAIGN_LEADS_ROTATED,
        entityType: 'campaign',
        entityId: id,
        newValue: { rotated: included.length, excluded: excluded.length },
        ipAddress: req.ip,
      });
    }

    return ok(
      { rotated: included.length, excluded: excluded.length, dry_run: body.dry_run, decisions },
      { message: body.dry_run ? `${included.length} lead(s) would be re-queued, ${excluded.length} excluded.` : `${included.length} lead(s) re-queued for another attempt.` },
    );
  });
}
