import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import {
  bulkDeleteLeadListsSchema,
  createLeadListSchema,
  exportLeadListSchema,
  listLeadListsQuerySchema,
  updateLeadListSchema,
} from '../schemas/leadLists.js';
import { uuidSchema } from '../schemas/common.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';
import { parseAndValidateImportJob } from '../services/importLeads.js';
import { queueLeadsExport } from '../services/exportGenerators/leadsExport.js';

export async function leadListRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // ---------------------------------------------------------------
  // GET /api/v1/lead-lists - paginated, with lead counts
  // ---------------------------------------------------------------
  app.get('/', { preHandler: requirePermission('leads.view') }, async (req) => {
    const query = listLeadListsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase
      .from('lead_lists')
      .select('id, organization_id, name, description, created_by, created_at, updated_at', {
        count: 'exact',
      })
      .eq('organization_id', orgId);
    if (query.search) builder = builder.ilike('name', `%${query.search}%`);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data: lists, error, count } = await builder;
    if (error) throw error;

    const listIds = (lists ?? []).map((l: any) => l.id);
    const counts = new Map<string, number>();
    if (listIds.length > 0) {
      // Performance: a grouped-count RPC (migration
      // 00000000000054_lead_list_member_counts_bulk_fn.sql) instead of
      // downloading every membership row for every list on the page just
      // to count them in JS - a list with thousands of members used to
      // pull thousands of rows over the wire on every single page load.
      const { data: memberCounts, error: memberError } = await supabase.rpc('lead_list_member_counts_bulk', {
        p_lead_list_ids: listIds,
      });
      if (memberError) throw memberError;
      for (const row of (memberCounts ?? []) as { lead_list_id: string; count: number }[]) {
        counts.set(row.lead_list_id, Number(row.count));
      }
    }

    const withCounts = (lists ?? []).map((l: any) => ({ ...l, lead_count: counts.get(l.id) ?? 0 }));
    return ok(withCounts, { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // ---------------------------------------------------------------
  // GET /api/v1/lead-lists/:id
  // ---------------------------------------------------------------
  app.get('/:id', { preHandler: requirePermission('leads.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();

    const { data: list, error } = await supabase
      .from('lead_lists')
      .select('id, organization_id, name, description, created_by, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!list || list.organization_id !== req.user!.organizationId) {
      throw new NotFoundError('Lead list not found.');
    }

    const { count } = await supabase
      .from('lead_list_members')
      .select('lead_id', { count: 'exact', head: true })
      .eq('lead_list_id', id);

    return ok({ ...list, lead_count: count ?? 0 });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/lead-lists
  // ---------------------------------------------------------------
  app.post('/', { preHandler: requirePermission('leads.create') }, async (req, reply) => {
    const body = createLeadListSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: list, error } = await supabase
      .from('lead_lists')
      .insert({
        organization_id: orgId,
        name: body.name,
        description: body.description ?? null,
        created_by: req.user!.id,
      })
      .select('id, organization_id, name, description, created_by, created_at, updated_at')
      .single();
    if (error) {
      if ((error as any).code === '23505') throw new ConflictError('A lead list with this name already exists.');
      throw error;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_LIST_CREATED,
      entityType: 'lead_list',
      entityId: list.id,
      newValue: { name: body.name },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok({ ...list, lead_count: 0 }, { message: 'Lead list created.' }));
  });

  // ---------------------------------------------------------------
  // PATCH /api/v1/lead-lists/:id
  // ---------------------------------------------------------------
  app.patch('/:id', { preHandler: requirePermission('leads.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateLeadListSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing, error: existingError } = await supabase
      .from('lead_lists')
      .select('id, organization_id, name, description')
      .eq('id', id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Lead list not found.');

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('lead_lists').update(patch).eq('id', id);
      if (error) {
        if ((error as any).code === '23505') throw new ConflictError('A lead list with this name already exists.');
        throw error;
      }
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_LIST_UPDATED,
      entityType: 'lead_list',
      entityId: id,
      oldValue: existing,
      newValue: patch,
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase
      .from('lead_lists')
      .select('id, organization_id, name, description, created_by, created_at, updated_at')
      .eq('id', id)
      .single();
    return ok(updated);
  });

  // ---------------------------------------------------------------
  // DELETE /api/v1/lead-lists/:id
  // ---------------------------------------------------------------
  app.delete('/:id', { preHandler: requirePermission('leads.delete') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing, error: existingError } = await supabase
      .from('lead_lists')
      .select('id, organization_id, name')
      .eq('id', id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Lead list not found.');

    // Leads themselves are not deleted - only list membership and any
    // lead rows whose "primary list" pointer is this list are cleared.
    await supabase.from('lead_list_members').delete().eq('lead_list_id', id);
    await supabase.from('leads').update({ lead_list_id: null }).eq('lead_list_id', id).eq('organization_id', orgId);

    const { error } = await supabase.from('lead_lists').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_LIST_DELETED,
      entityType: 'lead_list',
      entityId: id,
      oldValue: { name: existing.name },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/lead-lists/bulk-delete
  // ---------------------------------------------------------------
  app.post('/bulk-delete', { preHandler: requirePermission('leads.delete') }, async (req) => {
    const body = bulkDeleteLeadListsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: owned, error: ownedError } = await supabase
      .from('lead_lists')
      .select('id')
      .eq('organization_id', orgId)
      .in('id', body.lead_list_ids);
    if (ownedError) throw ownedError;
    const ids = (owned ?? []).map((l: any) => l.id as string);

    if (ids.length > 0) {
      // Leads themselves are not deleted - only list membership and any
      // lead rows whose "primary list" pointer is this list are cleared,
      // matching the single-list DELETE /:id above.
      await supabase.from('lead_list_members').delete().in('lead_list_id', ids);
      await supabase.from('leads').update({ lead_list_id: null }).in('lead_list_id', ids).eq('organization_id', orgId);
      const { error } = await supabase.from('lead_lists').delete().in('id', ids);
      if (error) throw error;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_LIST_BULK_ACTION,
      entityType: 'lead_list',
      entityId: null,
      newValue: { action: 'delete', affected: ids.length },
      ipAddress: req.ip,
    });

    return ok({ action: 'delete', affected: ids.length });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/lead-lists/:id/import - upload a CSV/XLSX file. Creates
  // an import_jobs row and hands off to
  // services/importLeads.parseAndValidateImportJob asynchronously (see
  // that file's header comment) so this request returns immediately
  // rather than blocking on parsing a potentially large file.
  // ---------------------------------------------------------------
  app.post('/:id/import', { preHandler: requirePermission('leads.import') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: list } = await supabase
      .from('lead_lists')
      .select('id, organization_id')
      .eq('id', id)
      .maybeSingle();
    if (!list || list.organization_id !== orgId) throw new NotFoundError('Lead list not found.');

    if (!req.isMultipart()) {
      throw new ValidationError('Upload must be sent as multipart/form-data with a "file" field.');
    }

    const file = await req.file({ limits: { fileSize: 25 * 1024 * 1024 } });
    if (!file) throw new ValidationError('No file was uploaded.');
    if (!/\.(csv|tsv|txt|xlsx|xlsm)$/i.test(file.filename)) {
      throw new ValidationError('Only .csv, .tsv, .txt and .xlsx files are supported.');
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) throw new ValidationError('The uploaded file is empty.');

    const { data: job, error } = await supabase
      .from('import_jobs')
      .insert({
        organization_id: orgId,
        lead_list_id: id,
        file_name: file.filename,
        file_storage_path: `memory:${orgId}/${file.filename}`,
        status: 'pending',
        created_by: req.user!.id,
      })
      .select('id, organization_id, lead_list_id, file_name, status, created_at')
      .single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.IMPORT_JOB_CREATED,
      entityType: 'import_job',
      entityId: job.id,
      newValue: { file_name: file.filename },
      ipAddress: req.ip,
    });

    // Fire-and-forget: no queue/worker infra yet (Phase 15 adds
    // Redis/BullMQ), so processing runs on this same backend process via
    // setImmediate rather than blocking the HTTP response. See
    // services/importLeads.ts for how a future queue worker takes this
    // over unchanged.
    setImmediate(() => {
      parseAndValidateImportJob(job.id, buffer, file.filename).catch((err) => {
        req.log.error({ err, jobId: job.id }, 'Import job processing failed');
      });
    });

    return reply.status(202).send(ok(job, { message: 'Import started.' }));
  });

  // ---------------------------------------------------------------
  // POST /api/v1/lead-lists/:id/export - queues a background CSV/XLSX
  // export of every lead in this list (Phase 14). Scoped via
  // entity_reference.leadListId so the Export History view can link
  // straight back to this list.
  // ---------------------------------------------------------------
  app.post('/:id/export', { preHandler: requirePermission('leads.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = exportLeadListSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: list } = await supabase.from('lead_lists').select('id, organization_id').eq('id', id).maybeSingle();
    if (!list || list.organization_id !== orgId) throw new NotFoundError('Lead list not found.');

    const exportRecord = await queueLeadsExport(orgId, req.user!.id, body.type, { lead_list_id: id }, { leadListId: id });

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEADS_EXPORT_CREATED,
      entityType: 'export',
      entityId: exportRecord.id,
      newValue: { type: body.type, lead_list_id: id },
      ipAddress: req.ip,
    });

    return ok(exportRecord, { message: 'Export queued. Check its status via GET /api/v1/exports/:id.' });
  });
}
