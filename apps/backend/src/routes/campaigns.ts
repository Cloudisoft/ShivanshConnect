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
  removeLeadsSchema,
  rotateLeadsSchema,
  setCampaignPhoneNumbersSchema,
  updateCampaignSchema,
  updateConcurrencySchema,
} from '../schemas/campaigns.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, type CampaignCallingRulesSnapshot, type CampaignDispositionRulesSnapshot } from '@shivanshconnect/shared';
import { runCampaignPreflight } from '../services/campaignPreflight.js';
import { decideRotation } from '../services/campaignRotate.js';
import { chunkArray } from '../lib/arrayChunk.js';

/** Keeps every `.in(column, [...])` filter below in safe territory (see
 * lib/arrayChunk.ts's header comment). */
const ID_QUERY_BATCH_SIZE = 200;

/** Real Supabase's `.in()` doesn't accept an unbounded array (see
 * ID_QUERY_BATCH_SIZE) - runs one filtered select per batch in parallel
 * and concatenates the results. */
async function selectInBatches<T>(
  runQuery: (batch: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
  ids: string[],
): Promise<T[]> {
  if (ids.length === 0) return [];
  const results = await Promise.all(chunkArray(ids, ID_QUERY_BATCH_SIZE).map(runQuery));
  const rows: T[] = [];
  for (const { data, error } of results) {
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}

type Supabase = ReturnType<typeof getSupabaseAdmin>;

async function getOwnedCampaign(supabase: Supabase, id: string, orgId: string) {
  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!campaign || campaign.organization_id !== orgId) throw new NotFoundError('Campaign not found.');
  return campaign;
}

function buildCampaignCounts(statusCounts: Record<string, number>, activeCalls: number) {
  let total = 0;
  for (const v of Object.values(statusCounts)) total += v;
  return {
    total,
    pending: statusCounts.pending ?? 0,
    queued: statusCounts.queued ?? 0,
    dialing: statusCounts.dialing ?? 0,
    in_progress: statusCounts.in_progress ?? 0,
    connected: statusCounts.connected ?? 0,
    completed: statusCounts.completed ?? 0,
    failed: statusCounts.failed ?? 0,
    retry_pending: statusCounts.retry_pending ?? 0,
    skipped: statusCounts.skipped ?? 0,
    dnc: statusCounts.dnc ?? 0,
    active_calls: activeCalls,
  };
}

// Performance: this used to be 12 separate COUNT queries (one per
// CAMPAIGN_LEAD_STATUSES entry) plus 2 more sequential ones (total,
// active_calls) - 14 round trips just to render one campaign card. Now a
// single grouped-count RPC (see migration
// 00000000000051_campaign_lead_status_counts_fn.sql) plus the one
// active-calls count, run in parallel - 2 round trips total. Used by
// GET /campaigns/:id (a single campaign) - the list route below uses the
// bulk variant instead, so it never pays this per-row.
async function computeCampaignCounts(supabase: Supabase, campaignId: string) {
  const [{ data: statusCounts, error: statusError }, { count: activeCalls, error: activeError }] = await Promise.all([
    supabase.rpc('campaign_lead_status_counts', { p_campaign_id: campaignId }),
    supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('status', ['queued', 'dialing', 'ringing', 'answered', 'in_progress', 'voicemail', 'answering_machine', 'transfer_pending', 'transferring']),
  ]);
  if (statusError) throw statusError;
  if (activeError) throw activeError;

  const counts: Record<string, number> = {};
  for (const row of (statusCounts ?? []) as { status: string; count: number }[]) {
    counts[row.status] = Number(row.count);
  }
  return buildCampaignCounts(counts, activeCalls ?? 0);
}

// Performance fix (this page's actual slowness): GET /campaigns still
// called computeCampaignCounts() once PER campaign row - 2 round trips
// each, so a page of 20 campaigns fired 40 concurrent DB round trips just
// to render the list. This bulk variant (migration
// 00000000000053_campaign_counts_bulk_fns.sql) fetches every campaign's
// counts in exactly 2 round trips total for the whole page, no matter how
// many campaigns are on it.
async function computeCampaignCountsBulk(
  supabase: Supabase,
  campaignIds: string[],
): Promise<Map<string, ReturnType<typeof buildCampaignCounts>>> {
  const result = new Map<string, ReturnType<typeof buildCampaignCounts>>();
  if (campaignIds.length === 0) return result;

  const [{ data: statusRows, error: statusError }, { data: activeRows, error: activeError }] = await Promise.all([
    supabase.rpc('campaign_lead_status_counts_bulk', { p_campaign_ids: campaignIds }),
    supabase.rpc('campaign_active_call_counts_bulk', { p_campaign_ids: campaignIds }),
  ]);
  if (statusError) throw statusError;
  if (activeError) throw activeError;

  const statusByCampaign = new Map<string, Record<string, number>>();
  for (const row of (statusRows ?? []) as { campaign_id: string; status: string; count: number }[]) {
    const bucket = statusByCampaign.get(row.campaign_id) ?? {};
    bucket[row.status] = Number(row.count);
    statusByCampaign.set(row.campaign_id, bucket);
  }
  const activeByCampaign = new Map<string, number>();
  for (const row of (activeRows ?? []) as { campaign_id: string; count: number }[]) {
    activeByCampaign.set(row.campaign_id, Number(row.count));
  }

  for (const id of campaignIds) {
    result.set(id, buildCampaignCounts(statusByCampaign.get(id) ?? {}, activeByCampaign.get(id) ?? 0));
  }
  return result;
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

    const rows = data ?? [];
    const countsByCampaign = await computeCampaignCountsBulk(supabase, rows.map((c: any) => c.id));
    const withCounts = rows.map((c: any) => ({ ...c, counts: countsByCampaign.get(c.id) ?? buildCampaignCounts({}, 0) }));
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

    // current_version_id only ever points at the last PUBLISHED version
    // (see the /publish handler below - creating a version never touches
    // it) - a draft saved via POST /:id/versions was never returned here
    // at all, so reopening the Configuration tab after saving a draft
    // showed empty/stale fields instead of what was actually saved.
    const [counts, currentVersionResult, draftVersionResult, phoneNumbersResult] = await Promise.all([
      computeCampaignCounts(supabase, id),
      campaign.current_version_id
        ? supabase.from('campaign_versions').select('*').eq('id', campaign.current_version_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('campaign_versions').select('*').eq('campaign_id', id).eq('status', 'draft').order('version_number', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('campaign_phone_numbers').select('phone_numbers(*)').eq('campaign_id', id),
    ]);
    let phoneNumbers = ((phoneNumbersResult.data ?? []) as any[]).map((row) => row.phone_numbers).filter(Boolean);
    if (phoneNumbers.length === 0 && campaign.phone_number_id) {
      // Same legacy fallback the dispatcher itself uses (a campaign
      // created via the old single-number flow, or whose pool row was
      // never backfilled) - shows the UI's checkbox list what's actually
      // configured and will actually be dialed from, rather than an
      // empty list that contradicts a real, working single-number setup.
      const { data: legacy } = await supabase.from('phone_numbers').select('*').eq('id', campaign.phone_number_id).maybeSingle();
      if (legacy) phoneNumbers = [legacy];
    }

    return ok({ ...campaign, counts, current_version: currentVersionResult.data ?? null, draft_version: draftVersionResult.data ?? null, phone_numbers: phoneNumbers });
  });

  // GET /api/v1/campaigns/:id/phone-numbers - the campaign's dialing pool
  // (any mix of providers - a number's own provider_key is resolved
  // independently per call, so mixing Twilio/Telnyx numbers in the same
  // pool has never actually been a problem, only the lack of a
  // multi-select UI to build one was).
  app.get('/:id/phone-numbers', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedCampaign(supabase, id, orgId);

    const { data, error } = await supabase.from('campaign_phone_numbers').select('phone_numbers(*)').eq('campaign_id', id);
    if (error) throw error;
    return ok(((data ?? []) as any[]).map((row) => row.phone_numbers).filter(Boolean));
  });

  // PUT /api/v1/campaigns/:id/phone-numbers - replaces the campaign's
  // whole dialing pool with exactly this set (see the schema's own
  // comment for why a full replace rather than add/remove).
  app.put('/:id/phone-numbers', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = setCampaignPhoneNumbersSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);

    if (body.phone_number_ids.length > 0) {
      const { data: owned, error: ownedError } = await supabase
        .from('phone_numbers')
        .select('id')
        .eq('organization_id', orgId)
        .in('id', body.phone_number_ids);
      if (ownedError) throw ownedError;
      const ownedIds = new Set((owned ?? []).map((n: any) => n.id));
      const missing = body.phone_number_ids.filter((pid) => !ownedIds.has(pid));
      if (missing.length > 0) {
        throw new ValidationError('One or more selected phone numbers do not belong to your organization.');
      }
    }

    const { error: deleteError } = await supabase.from('campaign_phone_numbers').delete().eq('campaign_id', id);
    if (deleteError) throw deleteError;
    if (body.phone_number_ids.length > 0) {
      const { error: insertError } = await supabase
        .from('campaign_phone_numbers')
        .insert(body.phone_number_ids.map((phoneNumberId) => ({ campaign_id: id, phone_number_id: phoneNumberId, organization_id: orgId })));
      if (insertError) throw insertError;
    }
    // Legacy single-number column kept in sync for any code path that
    // still reads it directly (e.g. an org that never adds a second
    // number never needs the pool at all) - set to the first selected
    // number, or cleared when the pool is emptied.
    await supabase.from('campaigns').update({ phone_number_id: body.phone_number_ids[0] ?? null }).eq('id', id);

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CAMPAIGN_UPDATED,
      entityType: 'campaign',
      entityId: id,
      oldValue: { phone_number_id: campaign.phone_number_id },
      newValue: { phone_number_ids: body.phone_number_ids },
      ipAddress: req.ip,
    });

    return ok({ phone_number_ids: body.phone_number_ids }, { message: 'Campaign phone numbers updated.' });
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

  // POST /api/v1/campaigns/:id/restart - a stopped/completed/failed
  // campaign is otherwise terminal (unlike a paused one, which /resume
  // already handles); this reopens it for dialing again without going
  // through archive/duplicate. Leads themselves are untouched - whatever
  // is still eligible under the campaign's own cooldown/attempt rules
  // (campaign_leads) simply continues from where it left off, exactly
  // like a fresh /start would pick them up.
  app.post('/:id/restart', { preHandler: requirePermission('campaigns.start') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const campaign = await getOwnedCampaign(supabase, id, orgId);
    if (!['stopped', 'completed', 'failed'].includes(campaign.status)) {
      throw new ValidationError(`Campaign cannot be restarted from status "${campaign.status}".`);
    }

    const preflight = await runCampaignPreflight(supabase, orgId, id);
    if (!preflight.ready) {
      throw new ValidationError('Campaign is not ready to restart.', { errors: preflight.errors });
    }

    const isFutureStart = campaign.start_date && new Date(campaign.start_date) > new Date();
    const nextStatus = isFutureStart ? 'scheduled' : 'running';

    const { data: updated, error } = await supabase.from('campaigns').update({ status: nextStatus }).eq('id', id).select('*').single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CAMPAIGN_RESTARTED, entityType: 'campaign', entityId: id, oldValue: { status: campaign.status }, newValue: { status: nextStatus }, ipAddress: req.ip });
    return ok(updated, { message: nextStatus === 'running' ? 'Campaign restarted.' : 'Campaign scheduled to restart.' });
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
    //
    // Bug fix: a real production incident - attaching a large lead list
    // (created via a bulk import) built a single unbatched
    // .in('id', [...]) filter whose request URL exceeded PostgREST's
    // ~16KB header limit and failed outright with a bare "Something went
    // wrong" (HeadersOverflowError). Both lookups below now run in
    // batches of 200 ids at a time instead of one unbounded query.
    const validLeads = await selectInBatches<{ id: string; organization_id: string; is_dnc: boolean }>(
      (batch) => supabase.from('leads').select('id, organization_id, is_dnc').in('id', batch),
      leadIds,
    );
    const ownLeadIds = validLeads.filter((l) => l.organization_id === orgId).map((l) => l.id);

    const existing = await selectInBatches<{ lead_id: string }>(
      (batch) => supabase.from('campaign_leads').select('lead_id').eq('campaign_id', id).in('lead_id', batch),
      ownLeadIds,
    );
    const existingIds = new Set(existing.map((r) => r.lead_id));
    const toInsert = validLeads
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

  // POST /api/v1/campaigns/:id/leads/remove - detach lead(s) from this
  // campaign entirely (removes the campaign_leads row, never touches the
  // lead record itself). A lead mid-call (dialing/ringing/connected/
  // in_progress/transferring) is never removed - detaching it out from
  // under an active call would orphan the in-flight call's own
  // campaign_leads row; the org must let that call finish first.
  app.post('/:id/leads/remove', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = removeLeadsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedCampaign(supabase, id, orgId);

    const ACTIVE_STATUSES = ['dialing', 'ringing', 'connected', 'in_progress', 'transferring'];
    // Same batching fix as POST /:id/leads above - a large bulk selection
    // built an unbatched .in() filter that could exceed PostgREST's
    // header limit.
    const matched = await selectInBatches<{ id: string; lead_id: string; status: string }>(
      (batch) => supabase.from('campaign_leads').select('id, lead_id, status').eq('campaign_id', id).in('lead_id', batch),
      body.lead_ids,
    );

    const removable = matched.filter((cl) => !ACTIVE_STATUSES.includes(cl.status));
    const skippedActive = matched.length - removable.length;

    for (const batch of chunkArray(removable.map((cl) => cl.id), ID_QUERY_BATCH_SIZE)) {
      const { error } = await supabase.from('campaign_leads').delete().in('id', batch);
      if (error) throw error;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CAMPAIGN_LEADS_REMOVED,
      entityType: 'campaign',
      entityId: id,
      newValue: { removed: removable.length, skipped_active: skippedActive },
      ipAddress: req.ip,
    });

    const message =
      skippedActive > 0
        ? `${removable.length} lead(s) removed. ${skippedActive} skipped - currently on an active call.`
        : `${removable.length} lead(s) removed.`;
    return ok({ removed: removable.length, skipped_active: skippedActive }, { message });
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
