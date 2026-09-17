import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createCallbackSchema, listCallbacksQuerySchema, updateCallbackSchema } from '../schemas/callbacks.js';
import { createCallback } from '../services/callbackScheduler.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, CALLBACK_TERMINAL_STATUSES } from '@shivanshconnect/shared';

/**
 * Phase 8: callback scheduler routes (spec sections 17/53). Manual
 * creation/reschedule/cancel here shares the exact same
 * services/callbackScheduler.ts#createCallback() the tool-call webhook
 * handler uses - a human agent scheduling a callback from the lead detail
 * UI and the AI scheduling one mid-call are indistinguishable downstream.
 */
export async function callbackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/callbacks - list/filter, calendar-friendly date range.
  app.get('/', { preHandler: requirePermission('callbacks.manage') }, async (req) => {
    const query = listCallbacksQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('callbacks').select('*', { count: 'exact' }).eq('organization_id', orgId);
    if (query.status) builder = builder.eq('status', query.status);
    if (query.campaign_id) builder = builder.eq('campaign_id', query.campaign_id);
    if (query.lead_id) builder = builder.eq('lead_id', query.lead_id);
    if (query.from) builder = builder.gte('scheduled_at', query.from);
    if (query.to) builder = builder.lte('scheduled_at', query.to);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('scheduled_at', { ascending: true }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // GET /api/v1/callbacks/:id
  app.get('/:id', { preHandler: requirePermission('callbacks.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: callback, error } = await supabase.from('callbacks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!callback || callback.organization_id !== orgId) throw new NotFoundError('Callback not found.');
    return ok(callback);
  });

  // POST /api/v1/callbacks - manual creation (from CDR/lead detail UI).
  app.post('/', { preHandler: requirePermission('callbacks.manage') }, async (req) => {
    const body = createCallbackSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    if (body.campaign_id) {
      const { data: campaign } = await supabase.from('campaigns').select('id, organization_id').eq('id', body.campaign_id).maybeSingle();
      if (!campaign || campaign.organization_id !== orgId) throw new ValidationError('Campaign not found for this organization.');
    }

    const { callback } = await createCallback(supabase, {
      organizationId: orgId,
      leadId: body.lead_id,
      campaignId: body.campaign_id ?? null,
      phoneE164: body.phone_e164 ?? null,
      scheduledAt: body.scheduled_at,
      timezone: body.timezone,
      reason: body.reason ?? null,
      notes: body.notes ?? null,
      assignedTo: body.assigned_to ?? req.user!.id,
      sourceCallId: null,
      createdBy: req.user!.id,
    });

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.CALLBACK_CREATED, entityType: 'callback', entityId: callback.id, newValue: callback, ipAddress: req.ip });

    return ok(callback, { message: 'Callback scheduled.' });
  });

  // PATCH /api/v1/callbacks/:id - reschedule/cancel.
  app.patch('/:id', { preHandler: requirePermission('callbacks.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateCallbackSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: callback, error } = await supabase.from('callbacks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!callback || callback.organization_id !== orgId) throw new NotFoundError('Callback not found.');
    if (CALLBACK_TERMINAL_STATUSES.includes(callback.status)) {
      throw new ValidationError('This callback has already reached a final status and cannot be modified.');
    }

    const update: Record<string, unknown> = {};
    if (body.reason !== undefined) update.reason = body.reason;
    if (body.notes !== undefined) update.notes = body.notes;
    if (body.assigned_to !== undefined) update.assigned_to = body.assigned_to;
    if (body.timezone !== undefined) update.timezone = body.timezone;
    if (body.status !== undefined) update.status = body.status;

    let newScheduledAt: Date | null = null;
    if (body.scheduled_at !== undefined) {
      newScheduledAt = new Date(body.scheduled_at);
      if (Number.isNaN(newScheduledAt.getTime())) throw new ValidationError('scheduled_at must be a valid ISO 8601 timestamp.');
      update.scheduled_at = newScheduledAt.toISOString();
    }

    const { data: updated, error: updateError } = await supabase.from('callbacks').update(update).eq('id', id).select('*').single();
    if (updateError) throw updateError;

    // Rescheduling overrides cooldown the same way creation does - refresh
    // the linked campaign_leads row's next_eligible_at to the new time.
    // Cancelling releases that lead back to its normal eligibility state
    // (never leaves a stale future next_eligible_at pinned by a cancelled
    // callback).
    if (updated.campaign_id && (newScheduledAt || body.status === 'cancelled')) {
      const { data: campaignLead } = await supabase
        .from('campaign_leads')
        .select('id, status')
        .eq('campaign_id', updated.campaign_id)
        .eq('lead_id', updated.lead_id)
        .maybeSingle();
      if (campaignLead && !['dialing', 'ringing', 'connected', 'in_progress', 'transferring', 'dnc'].includes(campaignLead.status)) {
        if (body.status === 'cancelled') {
          await supabase.from('campaign_leads').update({ next_eligible_at: null }).eq('id', campaignLead.id);
        } else if (newScheduledAt) {
          await supabase.from('campaign_leads').update({ status: 'pending', next_eligible_at: newScheduledAt.toISOString() }).eq('id', campaignLead.id);
        }
      }
    }

    const action = body.status === 'cancelled' ? AUDIT_ACTIONS.CALLBACK_CANCELLED : AUDIT_ACTIONS.CALLBACK_UPDATED;
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action, entityType: 'callback', entityId: id, oldValue: callback, newValue: updated, ipAddress: req.ip });

    return ok(updated, { message: body.status === 'cancelled' ? 'Callback cancelled.' : 'Callback updated.' });
  });
}
