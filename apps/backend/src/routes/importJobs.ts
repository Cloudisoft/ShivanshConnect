import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { updateImportMappingSchema } from '../schemas/importJobs.js';
import { buildErrorReportCsv, commitImportJob, revalidateImportJob } from '../services/importLeads.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

const IMPORT_JOB_COLUMNS =
  'id, organization_id, lead_list_id, file_name, status, column_mapping, error_message, total_rows, valid_rows, invalid_rows, duplicate_rows, dnc_rows, imported_rows, error_report_path, created_by, created_at, updated_at';

export async function importJobRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('leads.import'));

  // ---------------------------------------------------------------
  // GET /api/v1/import-jobs/:id - poll status/progress/summary
  // ---------------------------------------------------------------
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();

    const { data: job, error } = await supabase.from('import_jobs').select(IMPORT_JOB_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!job || job.organization_id !== req.user!.organizationId) throw new NotFoundError('Import job not found.');

    return ok(job);
  });

  // ---------------------------------------------------------------
  // GET /api/v1/import-jobs/:id/rows - preview rows for the review screen
  // ---------------------------------------------------------------
  app.get('/:id/rows', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();

    const { data: job } = await supabase.from('import_jobs').select('id, organization_id').eq('id', id).maybeSingle();
    if (!job || job.organization_id !== req.user!.organizationId) throw new NotFoundError('Import job not found.');

    const query = req.query as { result?: string; limit?: string };
    let builder = supabase
      .from('import_job_rows')
      .select('id, row_number, raw_data, result, error_message, phone_normalized, lead_id')
      .eq('import_job_id', id)
      .order('row_number', { ascending: true });
    if (query.result) builder = builder.eq('result', query.result);
    const limit = Math.min(Number(query.limit) || 200, 1000);
    builder = builder.range(0, limit - 1);

    const { data, error } = await builder;
    if (error) throw error;
    return ok(data ?? []);
  });

  // ---------------------------------------------------------------
  // PATCH /api/v1/import-jobs/:id/mapping - adjust column mapping and
  // re-validate the already-uploaded rows.
  // ---------------------------------------------------------------
  app.patch('/:id/mapping', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateImportMappingSchema.parse(req.body);
    const supabase = getSupabaseAdmin();

    const { data: job } = await supabase
      .from('import_jobs')
      .select('id, organization_id, status')
      .eq('id', id)
      .maybeSingle();
    if (!job || job.organization_id !== req.user!.organizationId) throw new NotFoundError('Import job not found.');
    if (!['ready_for_review', 'failed'].includes(job.status)) {
      throw new ConflictError('Column mapping can only be changed before a job is committed.');
    }

    await revalidateImportJob(id, body.column_mapping);

    const { data: updated } = await supabase.from('import_jobs').select(IMPORT_JOB_COLUMNS).eq('id', id).single();
    return ok(updated);
  });

  // ---------------------------------------------------------------
  // POST /api/v1/import-jobs/:id/commit - insert the valid rows as leads
  // ---------------------------------------------------------------
  app.post('/:id/commit', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();

    const { data: job } = await supabase
      .from('import_jobs')
      .select('id, organization_id, status')
      .eq('id', id)
      .maybeSingle();
    if (!job || job.organization_id !== req.user!.organizationId) throw new NotFoundError('Import job not found.');
    if (job.status !== 'ready_for_review') {
      throw new ConflictError(`Import job cannot be committed from status "${job.status}".`);
    }

    const summary = await commitImportJob(id);

    await writeAuditLog({
      organizationId: req.user!.organizationId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.IMPORT_JOB_COMMITTED,
      entityType: 'import_job',
      entityId: id,
      newValue: { imported: summary.imported },
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('import_jobs').select(IMPORT_JOB_COLUMNS).eq('id', id).single();
    return ok(updated, { message: `${summary.imported} leads imported.` });
  });

  // ---------------------------------------------------------------
  // GET /api/v1/import-jobs/:id/errors - download error rows as CSV
  // ---------------------------------------------------------------
  app.get('/:id/errors', async (req, reply) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();

    const { data: job } = await supabase.from('import_jobs').select('id, organization_id').eq('id', id).maybeSingle();
    if (!job || job.organization_id !== req.user!.organizationId) throw new NotFoundError('Import job not found.');

    const csv = await buildErrorReportCsv(id);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="import-${id}-errors.csv"`);
    return reply.send(csv);
  });
}
