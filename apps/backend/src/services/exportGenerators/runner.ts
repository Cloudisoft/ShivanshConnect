/**
 * Phase 14: the ONE shared async-export-job engine every export type
 * (CDR, leads, SMS messages, email messages) runs through. Extracted out
 * of Phase 9's `cdrExport.ts` `queueCdrExport()`/`runExport()` pair,
 * whose exact `setImmediate`-scheduled, `exports`-row-driven,
 * StorageAdapter-backed pattern this reproduces unchanged - every export
 * type reuses THIS ONE runner rather than writing its own copy of it.
 */
import { getSupabaseAdmin } from '../../lib/supabase.js';
import { getStorageAdapter } from '../../lib/storage/index.js';
import { writeCsv, writeXlsx, type ExportColumn } from './writers.js';
import type { ExportRecord, ExportType } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

async function markExport(supabase: Supabase, id: string, values: Record<string, unknown>): Promise<void> {
  await supabase.from('exports').update(values).eq('id', id);
}

export interface ExportRowSet<T extends object> {
  rows: T[];
  columns: ExportColumn<T>[];
  sheetName: string;
}

/** Queues a new export job (an `exports` row in `pending` status) and
 * returns immediately - no file generation happens inside this call.
 * `entityReference` is the optional `{ leadListId }`/`{ smsCampaignId }`/
 * etc pointer this export was scoped to (pass `null` for filter-only
 * exports like CDR's). `filters` is deliberately typed loosely (any
 * plain object) since each export type has its own, differently-shaped
 * filter interface - it is only ever serialized into the `exports.
 * filters` jsonb column here, never interpreted by this shared runner. */
export async function queueExportJob(
  orgId: string,
  userId: string,
  type: ExportType,
  filters: object,
  entityReference: Record<string, unknown> | null,
): Promise<ExportRecord> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('exports')
    .insert({ organization_id: orgId, type, filters, entity_reference: entityReference ?? {}, status: 'pending', created_by: userId })
    .select('*')
    .single();
  if (error) throw error;
  return data as ExportRecord;
}

/** Runs one export job end to end: resolves the row set via `buildRows`
 * (each export type supplies its own org/filter-scoped query, but this
 * function owns everything after that - format selection, file writing,
 * storage, and marking the job ready/failed). Never throws to its caller
 * - any failure is captured as an honest `failed` row with a real reason,
 * exactly like Phase 9's `runExport()`. */
export async function runExportJob<T extends object>(
  exportId: string,
  isXlsx: boolean,
  buildRows: (exportRow: Record<string, any>) => Promise<ExportRowSet<T>>,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: exportRow } = await supabase.from('exports').select('*').eq('id', exportId).maybeSingle();
  if (!exportRow) return;

  await markExport(supabase, exportId, { status: 'processing' });

  try {
    const { rows, columns, sheetName } = await buildRows(exportRow);

    const buffer = isXlsx ? await writeXlsx(sheetName, rows, columns) : Buffer.from(writeCsv(rows, columns), 'utf-8');
    const extension = isXlsx ? 'xlsx' : 'csv';
    const contentType = isXlsx
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv';

    const storage = getStorageAdapter();
    const stored = await storage.putObject(`exports/${exportRow.organization_id}/${exportId}.${extension}`, buffer, contentType);

    await markExport(supabase, exportId, {
      status: 'ready',
      file_storage_path: stored.path,
      row_count: rows.length,
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed for an unknown reason.';
    await markExport(supabase, exportId, { status: 'failed', failure_reason: message, completed_at: new Date().toISOString() });
  }
}

/** Queues a job and schedules its processing via `setImmediate`, never
 * synchronously inside the caller's HTTP request - the shared shape every
 * `queue*Export()` function in this phase follows. */
export function scheduleExportJob<T extends object>(
  exportRecord: ExportRecord,
  isXlsx: boolean,
  buildRows: (exportRow: Record<string, any>) => Promise<ExportRowSet<T>>,
): void {
  setImmediate(() => {
    runExportJob(exportRecord.id, isXlsx, buildRows).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('runExportJob failed unexpectedly for export', exportRecord.id, err);
    });
  });
}
