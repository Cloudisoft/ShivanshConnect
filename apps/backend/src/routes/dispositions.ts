import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createDispositionSchema, listDispositionsQuerySchema, updateDispositionSchema } from '../schemas/dispositions.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

/**
 * Phase 8: dispositions - view the fixed system defaults (read-only) plus
 * CRUD on an org's own custom dispositions. System defaults
 * (organization_id null) are never editable/deletable through this route -
 * they are the deterministic engine's own vocabulary (services/
 * dispositionEngine.ts) and changing their code/name here would silently
 * break the engine's lookup.
 */
export async function dispositionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/dispositions - every system default plus this org's own
  // custom dispositions.
  app.get('/', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const query = listDispositionsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    const { data, error, count } = await supabase
      .from('dispositions')
      .select('id, organization_id, code, name, is_system, created_at', { count: 'exact' })
      .or(`organization_id.eq.${orgId},organization_id.is.null`)
      .order('is_system', { ascending: false })
      .order('name', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // POST /api/v1/dispositions - create a custom org disposition.
  app.post('/', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const body = createDispositionSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing } = await supabase.from('dispositions').select('id').eq('organization_id', orgId).eq('code', body.code).maybeSingle();
    if (existing) throw new ConflictError('A disposition with this code already exists for your organization.');

    const { data: created, error } = await supabase
      .from('dispositions')
      .insert({ organization_id: orgId, code: body.code, name: body.name, is_system: false })
      .select('*')
      .single();
    if (error) throw error;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.DISPOSITION_CREATED, entityType: 'disposition', entityId: created.id, newValue: created, ipAddress: req.ip });

    return ok(created, { message: 'Disposition created.' });
  });

  // PATCH /api/v1/dispositions/:id - rename a custom disposition (system
  // defaults are read-only, checked below).
  app.patch('/:id', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateDispositionSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: disposition, error } = await supabase.from('dispositions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!disposition || disposition.organization_id !== orgId) throw new NotFoundError('Disposition not found.');
    if (disposition.is_system) throw new ValidationError('System dispositions cannot be edited.');

    const { data: updated, error: updateError } = await supabase.from('dispositions').update({ name: body.name }).eq('id', id).select('*').single();
    if (updateError) throw updateError;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.DISPOSITION_UPDATED, entityType: 'disposition', entityId: id, oldValue: disposition, newValue: updated, ipAddress: req.ip });

    return ok(updated, { message: 'Disposition updated.' });
  });

  // DELETE /api/v1/dispositions/:id - delete a custom disposition (system
  // defaults are read-only). Refused if any call_dispositions row still
  // references it - never a dangling reference.
  app.delete('/:id', { preHandler: requirePermission('campaigns.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: disposition, error } = await supabase.from('dispositions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!disposition || disposition.organization_id !== orgId) throw new NotFoundError('Disposition not found.');
    if (disposition.is_system) throw new ValidationError('System dispositions cannot be deleted.');

    const { count } = await supabase.from('call_dispositions').select('id', { count: 'exact', head: true }).eq('disposition_id', id);
    if (count && count > 0) throw new ConflictError('This disposition is already assigned to one or more calls and cannot be deleted.');

    const { error: deleteError } = await supabase.from('dispositions').delete().eq('id', id);
    if (deleteError) throw deleteError;

    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.DISPOSITION_DELETED, entityType: 'disposition', entityId: id, oldValue: disposition, ipAddress: req.ip });

    return ok({ id }, { message: 'Disposition deleted.' });
  });
}
