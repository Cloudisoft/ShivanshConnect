import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import { findDncMatches, findExistingLeadPhones } from '../lib/leadHelpers.js';
import type { ColumnMapping } from '../schemas/importJobs.js';

/**
 * Phase 2 async lead import (master spec section 64).
 *
 * There is no queue/worker infra yet (Redis/BullMQ is Phase 15). Every
 * exported function here is a standalone, side-effect-scoped unit that
 * takes only plain data (a job id, and for `parseAndValidateImportJob` a
 * file buffer already in memory) and does its own Supabase reads/writes
 * - it does not touch Fastify request/reply objects. The route handler
 * in routes/leadLists.ts calls `setImmediate(() => parseAndValidateImportJob(...))`
 * so the HTTP response returns immediately while this runs in the
 * background on the same process.
 *
 * When Phase 15 adds a real queue, the migration is meant to be
 * mechanical: a BullMQ worker's job processor calls these same exported
 * functions with the same arguments (reading the uploaded file from real
 * object storage instead of an in-memory buffer) - no business logic
 * here needs to change, only what invokes it and where the file bytes
 * come from.
 */

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
}

const XLSX_EXTENSIONS = ['.xlsx', '.xlsm'];

function parseCsvBuffer(buffer: Buffer): ParsedFile {
  const records: Record<string, string>[] = parseCsv(buffer, {
    columns: (headerRow: string[]) => headerRow.map((h) => h.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

export async function parseFileBufferAsync(buffer: Buffer, fileName: string): Promise<ParsedFile> {
  const lower = fileName.toLowerCase();
  if (XLSX_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) return { headers: [], rows: [] };

    const rows: Record<string, string>[] = [];
    let headers: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = (row.values as unknown[]).slice(1); // exceljs 1-indexes row.values
      if (rowNumber === 1) {
        headers = values.map((v) => String(v ?? '').trim());
        return;
      }
      const record: Record<string, string> = {};
      headers.forEach((header, idx) => {
        if (!header) return;
        const cell = values[idx];
        record[header] = cell === null || cell === undefined ? '' : String(cell).trim();
      });
      rows.push(record);
    });
    return { headers, rows };
  }
  return parseCsvBuffer(buffer);
}

/** Best-effort header -> lead field inference, so a user isn't forced to
 * map every column by hand for a typical export. Anything not
 * recognized (and not a known custom field) is simply left unmapped. */
const FIELD_ALIASES: Record<string, string[]> = {
  first_name: ['first_name', 'firstname', 'first', 'fname', 'given name'],
  last_name: ['last_name', 'lastname', 'last', 'lname', 'surname', 'family name'],
  company: ['company', 'company_name', 'organization', 'business', 'business name'],
  phone: ['phone', 'phone_number', 'phonenumber', 'mobile', 'cell', 'telephone', 'number', 'primary phone'],
  email: ['email', 'email_address', 'e-mail', 'emailaddress'],
  address: ['address', 'address1', 'street', 'street_address'],
  city: ['city'],
  state: ['state', 'province'],
  zip: ['zip', 'zipcode', 'zip_code', 'postal', 'postal_code', 'postcode'],
  country: ['country'],
};

function normalizeHeaderKey(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

export function inferColumnMapping(
  headers: string[],
  customFields: { field_key: string; field_label: string }[],
): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const header of headers) {
    const key = normalizeHeaderKey(header);
    const targetEntry = Object.entries(FIELD_ALIASES).find(([, aliases]) =>
      aliases.some((alias) => normalizeHeaderKey(alias) === key),
    );
    if (targetEntry) {
      mapping[header] = targetEntry[0];
      continue;
    }
    const customMatch = customFields.find(
      (f) => normalizeHeaderKey(f.field_key) === key || normalizeHeaderKey(f.field_label) === key,
    );
    if (customMatch) {
      mapping[header] = `custom:${customMatch.field_key}`;
    }
  }
  return mapping;
}

interface RowValidationOutcome {
  result: 'valid' | 'invalid' | 'duplicate' | 'dnc';
  error_message: string | null;
  phone_normalized: string | null;
  mapped: Record<string, unknown> | null;
}

function mapRow(raw: Record<string, string>, mapping: ColumnMapping): { mapped: Record<string, unknown>; phoneRaw: string | null } {
  const mapped: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  let phoneRaw: string | null = null;

  for (const [header, target] of Object.entries(mapping)) {
    const value = raw[header];
    if (value === undefined) continue;
    if (target === 'phone') {
      phoneRaw = value;
    } else if (target.startsWith('custom:')) {
      customFields[target.slice('custom:'.length)] = value;
    } else {
      mapped[target] = value;
    }
  }
  if (Object.keys(customFields).length > 0) mapped.custom_fields = customFields;
  return { mapped, phoneRaw };
}

/**
 * Validates every raw row against the current column mapping: normalizes
 * phone, flags invalid/duplicate(in-file or existing)/DNC rows, and
 * returns each row's outcome plus the mapped lead fields for rows that
 * will actually be inserted. Pure with respect to the database except
 * for the DNC/existing-phone lookups it needs to do the checks.
 */
export async function validateRows(
  organizationId: string,
  rawRows: Record<string, string>[],
  mapping: ColumnMapping,
): Promise<RowValidationOutcome[]> {
  const supabase = getSupabaseAdmin();

  const mappedRows = rawRows.map((raw) => mapRow(raw, mapping));
  const normalizedPhones: (string | null)[] = mappedRows.map(({ phoneRaw }) => {
    if (!phoneRaw) return null;
    const result = normalizePhoneNumber(phoneRaw);
    return result.valid ? result.e164 : null;
  });

  const candidatePhones = normalizedPhones.filter((p): p is string => Boolean(p));
  const [existingPhones, dncPhones] = await Promise.all([
    findExistingLeadPhones(supabase, organizationId, candidatePhones),
    findDncMatches(supabase, organizationId, candidatePhones),
  ]);

  const seenInFile = new Set<string>();
  const outcomes: RowValidationOutcome[] = [];

  for (let i = 0; i < rawRows.length; i += 1) {
    const { mapped, phoneRaw } = mappedRows[i];
    if (!phoneRaw || !phoneRaw.trim()) {
      outcomes.push({ result: 'invalid', error_message: 'Missing phone number.', phone_normalized: null, mapped: null });
      continue;
    }
    const normalized = normalizePhoneNumber(phoneRaw);
    if (!normalized.valid) {
      outcomes.push({ result: 'invalid', error_message: normalized.reason, phone_normalized: null, mapped: null });
      continue;
    }

    const e164 = normalized.e164;
    if (dncPhones.has(e164)) {
      outcomes.push({ result: 'dnc', error_message: 'Phone number is on the Do Not Call list.', phone_normalized: e164, mapped: null });
      continue;
    }
    if (existingPhones.has(e164) || seenInFile.has(e164)) {
      outcomes.push({
        result: 'duplicate',
        error_message: seenInFile.has(e164)
          ? 'Duplicate phone number elsewhere in this file.'
          : 'A lead with this phone number already exists.',
        phone_normalized: e164,
        mapped: null,
      });
      continue;
    }

    seenInFile.add(e164);
    outcomes.push({
      result: 'valid',
      error_message: null,
      phone_normalized: e164,
      mapped: {
        ...mapped,
        phone_original: phoneRaw,
        phone_normalized: e164,
        country_code: normalized.countryCode,
      },
    });
  }

  return outcomes;
}

/**
 * Full first pass for a freshly-uploaded file: parse -> infer/accept a
 * column mapping -> validate every row -> persist import_job_rows ->
 * update the job's summary counts and status. Called once, right after
 * upload, off the request/response cycle via setImmediate.
 */
export async function parseAndValidateImportJob(
  jobId: string,
  buffer: Buffer,
  fileName: string,
  explicitMapping?: ColumnMapping,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  try {
    await supabase.from('import_jobs').update({ status: 'parsing' }).eq('id', jobId);

    const { data: job, error: jobError } = await supabase
      .from('import_jobs')
      .select('id, organization_id')
      .eq('id', jobId)
      .single();
    if (jobError || !job) throw jobError ?? new Error('Import job not found');

    const { headers, rows } = await parseFileBufferAsync(buffer, fileName);
    if (rows.length === 0) {
      await supabase
        .from('import_jobs')
        .update({ status: 'failed', error_message: 'The uploaded file has no data rows.' })
        .eq('id', jobId);
      return;
    }

    const { data: customFields } = await supabase
      .from('lead_custom_fields')
      .select('field_key, field_label')
      .eq('organization_id', job.organization_id);

    const mapping = explicitMapping ?? inferColumnMapping(headers, customFields ?? []);
    if (!Object.values(mapping).includes('phone')) {
      await supabase
        .from('import_jobs')
        .update({
          status: 'failed',
          error_message: 'Could not find a phone number column. Provide a column mapping that maps a column to "phone".',
          column_mapping: mapping,
        })
        .eq('id', jobId);
      return;
    }

    await supabase.from('import_jobs').update({ status: 'validating', column_mapping: mapping }).eq('id', jobId);
    await runValidationAndStore(jobId, job.organization_id, rows, mapping);
  } catch (err) {
    await supabase
      .from('import_jobs')
      .update({ status: 'failed', error_message: err instanceof Error ? err.message : 'Import failed unexpectedly.' })
      .eq('id', jobId);
  }
}

async function runValidationAndStore(
  jobId: string,
  organizationId: string,
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const outcomes = await validateRows(organizationId, rows, mapping);

  await supabase.from('import_job_rows').delete().eq('import_job_id', jobId);

  // raw_data always keeps the row's original header-keyed values (never
  // the mapped/lead-shaped values) so a later column-mapping change can
  // re-validate from the same source, and the error-report CSV always
  // shows what was actually in the file.
  const rowsToInsert = outcomes.map((outcome, idx) => ({
    import_job_id: jobId,
    organization_id: organizationId,
    row_number: idx + 1,
    raw_data: rows[idx],
    result: outcome.result,
    error_message: outcome.error_message,
    phone_normalized: outcome.phone_normalized,
  }));

  // Batch inserts so a large file doesn't send one giant payload.
  const BATCH_SIZE = 500;
  for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
    const batch = rowsToInsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('import_job_rows').insert(batch);
    if (error) throw error;
  }

  const counts = outcomes.reduce(
    (acc, o) => {
      acc.total += 1;
      acc[o.result] += 1;
      return acc;
    },
    { total: 0, valid: 0, invalid: 0, duplicate: 0, dnc: 0 } as Record<string, number>,
  );

  await supabase
    .from('import_jobs')
    .update({
      status: 'ready_for_review',
      total_rows: counts.total,
      valid_rows: counts.valid,
      invalid_rows: counts.invalid,
      duplicate_rows: counts.duplicate,
      dnc_rows: counts.dnc,
    })
    .eq('id', jobId);
}

/** Re-runs validation using a new column mapping against already-stored
 * raw file rows (no need to touch the original file again). */
export async function revalidateImportJob(jobId: string, mapping: ColumnMapping): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: job, error: jobError } = await supabase
    .from('import_jobs')
    .select('id, organization_id')
    .eq('id', jobId)
    .single();
  if (jobError || !job) throw jobError ?? new Error('Import job not found');

  const { data: existingRows, error: rowsError } = await supabase
    .from('import_job_rows')
    .select('row_number, raw_data')
    .eq('import_job_id', jobId)
    .order('row_number', { ascending: true });
  if (rowsError) throw rowsError;

  // raw_data always holds each row's original header-keyed values (see
  // runValidationAndStore), so re-validating against a new mapping never
  // needs to re-read the uploaded file.
  const rawRows = (existingRows ?? []).map((r: any) => r.raw_data as Record<string, string>);

  await supabase.from('import_jobs').update({ status: 'validating', column_mapping: mapping }).eq('id', jobId);
  await runValidationAndStore(jobId, job.organization_id, rawRows, mapping);
}

export interface CommitSummary {
  imported: number;
}

/** Commits a ready_for_review job: inserts a real `leads` row (and
 * lead_list_members membership) for every row whose stored result is
 * 'valid', then marks the job completed. */
export async function commitImportJob(jobId: string): Promise<CommitSummary> {
  const supabase = getSupabaseAdmin();
  const { data: job, error: jobError } = await supabase
    .from('import_jobs')
    .select('id, organization_id, lead_list_id, status, column_mapping')
    .eq('id', jobId)
    .single();
  if (jobError || !job) throw jobError ?? new Error('Import job not found');
  if (job.status !== 'ready_for_review') {
    throw new Error(`Import job cannot be committed from status "${job.status}".`);
  }

  await supabase.from('import_jobs').update({ status: 'committing' }).eq('id', jobId);

  const { data: validRows, error: rowsError } = await supabase
    .from('import_job_rows')
    .select('id, raw_data, phone_normalized')
    .eq('import_job_id', jobId)
    .eq('result', 'valid');
  if (rowsError) throw rowsError;

  const mapping = (job.column_mapping ?? {}) as ColumnMapping;
  let imported = 0;
  const BATCH_SIZE = 200;
  const rows = validRows ?? [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const leadPayload = batch.map((row: any) => {
      const { mapped, phoneRaw } = mapRow(row.raw_data as Record<string, string>, mapping);
      const normalized = phoneRaw ? normalizePhoneNumber(phoneRaw) : null;
      return {
        organization_id: job.organization_id,
        lead_list_id: job.lead_list_id,
        first_name: mapped.first_name ?? '',
        last_name: mapped.last_name ?? '',
        company: mapped.company ?? null,
        phone_original: phoneRaw ?? row.phone_normalized,
        phone_normalized: row.phone_normalized,
        country_code: normalized?.valid ? normalized.countryCode : 'US',
        email: mapped.email ?? null,
        address: mapped.address ?? null,
        city: mapped.city ?? null,
        state: mapped.state ?? null,
        zip: mapped.zip ?? null,
        country: mapped.country ?? 'US',
        custom_fields: mapped.custom_fields ?? {},
      };
    });

    const { data: insertedLeads, error: insertError } = await supabase
      .from('leads')
      .insert(leadPayload)
      .select('id, phone_normalized');
    if (insertError) throw insertError;

    const memberPayload = (insertedLeads ?? []).map((lead: any) => ({
      lead_id: lead.id,
      lead_list_id: job.lead_list_id,
      organization_id: job.organization_id,
    }));
    if (memberPayload.length > 0) {
      const { error: memberError } = await supabase.from('lead_list_members').insert(memberPayload);
      if (memberError) throw memberError;
    }

    for (let j = 0; j < batch.length; j += 1) {
      const lead = (insertedLeads ?? [])[j];
      if (!lead) continue;
      await supabase.from('import_job_rows').update({ lead_id: lead.id }).eq('id', batch[j].id);
    }
    imported += (insertedLeads ?? []).length;
  }

  await supabase
    .from('import_jobs')
    .update({ status: 'completed', imported_rows: imported })
    .eq('id', jobId);

  return { imported };
}

/** Builds a CSV of every non-valid row for download (invalid, duplicate, DNC). */
export async function buildErrorReportCsv(jobId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('import_job_rows')
    .select('row_number, raw_data, result, error_message, phone_normalized')
    .eq('import_job_id', jobId)
    .in('result', ['invalid', 'duplicate', 'dnc'])
    .order('row_number', { ascending: true });
  if (error) throw error;

  const header = 'row_number,result,phone_normalized,error_message,raw_data\n';
  const lines = (rows ?? []).map((r: any) => {
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [r.row_number, r.result, r.phone_normalized ?? '', r.error_message ?? '', JSON.stringify(r.raw_data)]
      .map(escape)
      .join(',');
  });
  return header + lines.join('\n');
}
