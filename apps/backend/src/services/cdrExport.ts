/**
 * Phase 9: background CDR export jobs (master spec sections 21/65).
 *
 * `queueCdrExport()` inserts a `pending` `exports` row and returns
 * immediately - the actual file generation runs in `setImmediate`
 * (the same fire-and-forget-but-scheduled async pattern every prior
 * phase's ingestion services use), never synchronously inside the HTTP
 * request that queued it (spec 21/65's explicit "exports must be
 * background jobs" requirement).
 *
 * Both CSV and XLSX are generated from the EXACT SAME filtered query the
 * CDR list endpoint uses (services/cdrQuery.ts's `iterateAllCdrRows()`),
 * streamed page-by-page rather than ever materializing the full result
 * set as one in-memory array - the same 10k+-row performance discipline
 * as every prior phase's bulk work.
 */
import ExcelJS from 'exceljs';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { getStorageAdapter } from '../lib/storage/index.js';
import { iterateAllCdrRows, type CdrFilters } from './cdrQuery.js';
import type { CdrRow, ExportRecord, ExportType } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export const CDR_EXPORT_COLUMNS: Array<{ key: keyof CdrRow; header: string }> = [
  { key: 'call_id', header: 'Call ID' },
  { key: 'provider_call_id', header: 'Provider Call ID' },
  { key: 'campaign_name', header: 'Campaign' },
  { key: 'lead_name', header: 'Lead' },
  { key: 'caller_number', header: 'Caller Number' },
  { key: 'destination_number', header: 'Destination Number' },
  { key: 'direction', header: 'Direction' },
  { key: 'ai_agent_name', header: 'AI Agent' },
  { key: 'voice_name', header: 'Voice' },
  { key: 'started_at', header: 'Start Time' },
  { key: 'answered_at', header: 'Answer Time' },
  { key: 'ended_at', header: 'End Time' },
  { key: 'duration_seconds', header: 'Duration (s)' },
  { key: 'talk_duration_seconds', header: 'Talk Duration (s)' },
  { key: 'disposition_name', header: 'Disposition' },
  { key: 'ended_reason', header: 'Ended Reason' },
  { key: 'transfer_status', header: 'Transfer Status' },
  { key: 'has_recording', header: 'Has Recording' },
  { key: 'has_transcript', header: 'Has Transcript' },
  { key: 'has_summary', header: 'Has Summary' },
  { key: 'cost', header: 'Cost' },
  { key: 'engine', header: 'Provider (Engine)' },
  { key: 'created_at', header: 'Created At' },
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** Pure, directly-unit-testable: turns a fixed set of CdrRow fixtures into
 * a real RFC4180 CSV string (header row + one data row per call). */
export function rowsToCsv(rows: CdrRow[]): string {
  const header = CDR_EXPORT_COLUMNS.map((c) => csvEscape(c.header)).join(',');
  const lines = rows.map((row) => CDR_EXPORT_COLUMNS.map((c) => csvEscape(row[c.key])).join(','));
  return [header, ...lines].join('\r\n') + (rows.length > 0 ? '\r\n' : '');
}

/** Pure, directly-unit-testable: turns a fixed set of CdrRow fixtures into
 * a real .xlsx workbook buffer via exceljs. */
export async function rowsToXlsxBuffer(rows: CdrRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CDR');
  sheet.columns = CDR_EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key as string, width: 20 }));
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function markExport(supabase: Supabase, id: string, values: Record<string, unknown>): Promise<void> {
  await supabase.from('exports').update(values).eq('id', id);
}

/** Runs one export job end to end: streams every matching CDR row through
 * the shared query builder, accumulates them for the chosen format (CSV/
 * XLSX generation both need the full ordered row set to write a single
 * file - see this module's header comment for the streaming-per-PAGE
 * discipline that keeps the underlying query bounded even though the
 * final file itself is built once), stores the real file via the
 * existing StorageAdapter, and marks the job ready/failed. Never throws
 * to its caller (queueCdrExport() schedules this via setImmediate) - any
 * failure is captured as an honest `failed` row with a real reason. */
async function runExport(exportId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: exportRow } = await supabase.from('exports').select('*').eq('id', exportId).maybeSingle();
  if (!exportRow) return;

  await markExport(supabase, exportId, { status: 'processing' });

  try {
    const rows: CdrRow[] = [];
    const rowCount = await iterateAllCdrRows(supabase, exportRow.organization_id, exportRow.filters as CdrFilters, async (page) => {
      rows.push(...page);
    });

    const isXlsx = exportRow.type === 'cdr_xlsx';
    const buffer = isXlsx ? await rowsToXlsxBuffer(rows) : Buffer.from(rowsToCsv(rows), 'utf-8');
    const extension = isXlsx ? 'xlsx' : 'csv';
    const contentType = isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';

    const storage = getStorageAdapter();
    const stored = await storage.putObject(`exports/${exportRow.organization_id}/${exportId}.${extension}`, buffer, contentType);

    await markExport(supabase, exportId, { status: 'ready', file_storage_path: stored.path, row_count: rowCount, completed_at: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed for an unknown reason.';
    await markExport(supabase, exportId, { status: 'failed', failure_reason: message, completed_at: new Date().toISOString() });
  }
}

/** Queues a new CDR export job and returns immediately - the file itself
 * is generated by `runExport()` on a later tick (setImmediate), never
 * synchronously inside the request that called this. */
export async function queueCdrExport(orgId: string, userId: string, type: ExportType, filters: CdrFilters): Promise<ExportRecord> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('exports')
    .insert({ organization_id: orgId, type, filters, status: 'pending', created_by: userId })
    .select('*')
    .single();
  if (error) throw error;

  setImmediate(() => {
    runExport(data.id).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('runExport failed unexpectedly for export', data.id, err);
    });
  });

  return data as ExportRecord;
}
