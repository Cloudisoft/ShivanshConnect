/**
 * Phase 9: export job status/history/download (master spec sections
 * 21/65). File generation itself lives in services/cdrExport.ts - this
 * module only ever reads `exports` rows and serves the finished file.
 */
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { listExportsQuerySchema } from '../schemas/cdr.js';
import { getStorageAdapter, LocalDiskStorageAdapter } from '../lib/storage/index.js';
import type { ExportWithDownload } from '@shivanshconnect/shared';

function withDownloadUrl(row: Record<string, any>): ExportWithDownload {
  return { ...row, download_url: row.status === 'ready' ? `/api/v1/exports/${row.id}/download` : null } as ExportWithDownload;
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/exports - export history (spec section 65).
  app.get('/', { preHandler: requirePermission('cdr.export') }, async (req) => {
    const query = listExportsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    const { data, error, count } = await supabase
      .from('exports')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return ok((data ?? []).map(withDownloadUrl), { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // GET /api/v1/exports/:id - poll status + a download link once ready.
  app.get('/:id', { preHandler: requirePermission('cdr.export') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: exportRow, error } = await supabase.from('exports').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!exportRow || exportRow.organization_id !== orgId) throw new NotFoundError('Export not found.');

    return ok(withDownloadUrl(exportRow));
  });

  // GET /api/v1/exports/:id/download - real file bytes.
  app.get('/:id/download', { preHandler: requirePermission('cdr.export') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: exportRow } = await supabase.from('exports').select('*').eq('id', id).maybeSingle();
    if (!exportRow || exportRow.organization_id !== orgId) throw new NotFoundError('Export not found.');
    if (exportRow.status !== 'ready' || !exportRow.file_storage_path) {
      throw new ValidationError('This export is not ready yet.');
    }

    const adapter = getStorageAdapter();
    if (!(adapter instanceof LocalDiskStorageAdapter)) {
      throw new ValidationError('Export storage is not available.');
    }
    const filePath = adapter.resolvePath(exportRow.file_storage_path);
    const buffer = await readFile(filePath);
    const isXlsx = exportRow.type === 'cdr_xlsx';
    reply.header('Content-Type', isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="cdr-export-${id}.${isXlsx ? 'xlsx' : 'csv'}"`);
    return reply.send(buffer);
  });
}
