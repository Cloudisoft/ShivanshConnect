/**
 * Export job status/history/download (master spec sections 21/64/65).
 * File generation itself lives in services/cdrExport.ts and, as of
 * Phase 14, services/exportGenerators/*.ts - this module only ever
 * reads `exports` rows and serves the finished file, and is the single
 * source of truth behind the unified "Export History" view across every
 * export type (CDR, leads, SMS messages, email messages): it was never
 * CDR-specific to begin with (it queries `exports` scoped to
 * organization_id only), so Phase 14 only had to add the `type` filter
 * and generalize the filename/content-type-by-extension logic below.
 *
 * Every export type shares `cdr.export`-or-equivalent history visibility
 * here for simplicity (spec 65's "show export history" requirement is
 * one unified view) - what a user can QUEUE a given export type is still
 * separately gated per-entity (leads.view, messaging.manage) in each
 * export-creating route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { authenticate } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { listExportsQuerySchema } from '../schemas/cdr.js';
import { getStorageAdapter, LocalDiskStorageAdapter } from '../lib/storage/index.js';
import type { ExportType, ExportWithDownload } from '@shivanshconnect/shared';

function withDownloadUrl(row: Record<string, any>): ExportWithDownload {
  return { ...row, download_url: row.status === 'ready' ? `/api/v1/exports/${row.id}/download` : null } as ExportWithDownload;
}

/** Every export type name ends in `_csv` or `_xlsx` - the file extension,
 * content type and download filename prefix all fall out of that
 * uniformly, so a new export type never needs a change here. */
function fileShapeFor(type: ExportType): { extension: 'csv' | 'xlsx'; contentType: string; namePrefix: string } {
  const isXlsx = type.endsWith('_xlsx');
  const namePrefix = type.replace(/_csv$|_xlsx$/, '').replace(/_/g, '-');
  return {
    extension: isXlsx ? 'xlsx' : 'csv',
    contentType: isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
    namePrefix,
  };
}

// Every export-creating route already gates queuing a NEW export behind
// its own entity permission (cdr.export, leads.view, messaging.manage).
// The unified history view here just needs to confirm the caller holds
// at least one of those - it never widens what any single export type's
// route itself requires.
const EXPORT_VIEW_PERMISSIONS = ['cdr.export', 'leads.view', 'messaging.manage'];
function requireAnyExportPermission() {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.user) throw new UnauthorizedError();
    if (!EXPORT_VIEW_PERMISSIONS.some((p) => req.user!.permissions.includes(p))) {
      throw new ForbiddenError('You need one of the export permissions (leads, messaging or CDR) to do that.');
    }
  };
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAnyExportPermission());

  // GET /api/v1/exports - unified export history across every export
  // type for this org (spec section 65), optionally filtered by `type`.
  app.get('/', async (req) => {
    const query = listExportsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    let builder = supabase.from('exports').select('*', { count: 'exact' }).eq('organization_id', orgId);
    if (query.type) builder = builder.eq('type', query.type);
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;

    return ok((data ?? []).map(withDownloadUrl), { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // GET /api/v1/exports/:id - poll status + a download link once ready.
  app.get('/:id', async (req) => {
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
  app.get('/:id/download', async (req, reply) => {
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
    const { extension, contentType, namePrefix } = fileShapeFor(exportRow.type as ExportType);
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `attachment; filename="${namePrefix}-export-${id}.${extension}"`);
    return reply.send(buffer);
  });
}
