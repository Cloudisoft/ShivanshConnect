/**
 * Phase 9: background CDR export jobs (master spec sections 21/65).
 *
 * `queueCdrExport()` inserts a `pending` `exports` row and returns
 * immediately - the actual file generation runs via the shared
 * Phase 14 `services/exportGenerators/runner.ts` engine (the same
 * fire-and-forget-but-scheduled `setImmediate` pattern every prior
 * phase's ingestion services use), never synchronously inside the HTTP
 * request that queued it (spec 21/65's explicit "exports must be
 * background jobs" requirement).
 *
 * Both CSV and XLSX are generated from the EXACT SAME filtered query the
 * CDR list endpoint uses (services/cdrQuery.ts's `iterateAllCdrRows()`),
 * streamed page-by-page rather than ever materializing the full result
 * set as one in-memory array until it's handed to the shared writer - the
 * same 10k+-row performance discipline as every prior phase's bulk work.
 *
 * Phase 14 note: the actual CSV/XLSX file-writing and the
 * queue-job/run-job/mark-ready-or-failed/store-via-StorageAdapter
 * machinery below were extracted into `services/exportGenerators/
 * writers.ts` and `services/exportGenerators/runner.ts` so Leads, SMS
 * message and email message exports reuse the exact same engine instead
 * of forking it. `rowsToCsv()`/`rowsToXlsxBuffer()`/`CDR_EXPORT_COLUMNS`
 * keep their original signatures and behavior unchanged - this refactor
 * is a regression-risk area, and `cdrExport.test.ts` (unchanged) is what
 * proves it.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { iterateAllCdrRows, type CdrFilters } from './cdrQuery.js';
import { queueExportJob, runExportJob, scheduleExportJob } from './exportGenerators/runner.js';
import { writeCsv, writeXlsx, type ExportColumn } from './exportGenerators/writers.js';
import type { CdrRow, ExportRecord, ExportType } from '@shivanshconnect/shared';

export const CDR_EXPORT_COLUMNS: Array<ExportColumn<CdrRow>> = [
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

/** Pure, directly-unit-testable: turns a fixed set of CdrRow fixtures into
 * a real RFC4180 CSV string (header row + one data row per call). */
export function rowsToCsv(rows: CdrRow[]): string {
  return writeCsv(rows, CDR_EXPORT_COLUMNS);
}

/** Pure, directly-unit-testable: turns a fixed set of CdrRow fixtures into
 * a real .xlsx workbook buffer via exceljs. */
export async function rowsToXlsxBuffer(rows: CdrRow[]): Promise<Buffer> {
  return writeXlsx('CDR', rows, CDR_EXPORT_COLUMNS);
}

async function buildCdrExportRows(exportRow: Record<string, any>): Promise<{ rows: CdrRow[]; columns: typeof CDR_EXPORT_COLUMNS; sheetName: string }> {
  const rows: CdrRow[] = [];
  await iterateAllCdrRows(getSupabaseAdmin(), exportRow.organization_id, exportRow.filters as CdrFilters, async (page) => {
    rows.push(...page);
  });
  return { rows, columns: CDR_EXPORT_COLUMNS, sheetName: 'CDR' };
}

/** Runs one CDR export job end to end - kept for direct unit-testability/
 * backward compatibility with anything importing it directly; delegates
 * to the shared runner. */
export async function runExport(exportId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: exportRow } = await supabase.from('exports').select('type').eq('id', exportId).maybeSingle();
  const isXlsx = exportRow?.type === 'cdr_xlsx';
  return runExportJob(exportId, isXlsx, buildCdrExportRows);
}

/** Queues a new CDR export job and returns immediately - the file itself
 * is generated on a later tick (setImmediate), never synchronously inside
 * the request that called this. */
export async function queueCdrExport(orgId: string, userId: string, type: ExportType, filters: CdrFilters): Promise<ExportRecord> {
  const record = await queueExportJob(orgId, userId, type, filters, null);
  scheduleExportJob(record, type === 'cdr_xlsx', buildCdrExportRows);
  return record;
}
