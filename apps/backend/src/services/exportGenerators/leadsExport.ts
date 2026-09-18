/**
 * Phase 14: leads export (master spec section 15's standard lead
 * columns, plus this org's custom fields catalog - Phase 2's
 * `lead_custom_fields`). Reuses the exact same filter shape
 * `GET /api/v1/leads` supports (lead_list_id, status, is_dnc, search) so
 * "export what I'm looking at" always matches the on-screen list, and
 * runs through the SAME Phase 9 export engine (`exportGenerators/
 * runner.ts`) every other export type uses - never a second one.
 */
import { getSupabaseAdmin } from '../../lib/supabase.js';
import type { ExportColumn } from './writers.js';
import { queueExportJob, scheduleExportJob } from './runner.js';
import type { ExportRecord, ExportType } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface LeadsExportFilters {
  lead_list_id?: string | null;
  status?: string;
  is_dnc?: boolean;
  search?: string;
}

const BASE_COLUMNS: Array<{ key: string; header: string }> = [
  { key: 'first_name', header: 'First Name' },
  { key: 'last_name', header: 'Last Name' },
  { key: 'company', header: 'Company' },
  { key: 'phone_original', header: 'Phone (Original)' },
  { key: 'phone_normalized', header: 'Phone (E.164)' },
  { key: 'email', header: 'Email' },
  { key: 'address', header: 'Address' },
  { key: 'city', header: 'City' },
  { key: 'state', header: 'State' },
  { key: 'zip', header: 'Zip' },
  { key: 'country', header: 'Country' },
  { key: 'lead_list_name', header: 'Lead List' },
  { key: 'status', header: 'Status' },
  { key: 'attempts', header: 'Attempts' },
  { key: 'last_called_at', header: 'Last Called' },
  { key: 'last_disposition', header: 'Last Disposition' },
  { key: 'next_callback_at', header: 'Next Callback' },
  { key: 'is_dnc', header: 'DNC' },
  { key: 'dnc_reason', header: 'DNC Reason' },
  { key: 'created_at', header: 'Created At' },
];

const LEAD_SELECT_COLUMNS =
  'id, lead_list_id, first_name, last_name, company, phone_original, phone_normalized, email, address, city, state, zip, country, status, attempts, last_called_at, last_disposition, next_callback_at, is_dnc, dnc_reason, custom_fields, created_at';

function applyLeadFilters(builder: any, orgId: string, filters: LeadsExportFilters): any {
  let b = builder.eq('organization_id', orgId);
  if (filters.lead_list_id) b = b.eq('lead_list_id', filters.lead_list_id);
  if (filters.status) b = b.eq('status', filters.status);
  if (filters.is_dnc !== undefined) b = b.eq('is_dnc', filters.is_dnc);
  if (filters.search) {
    const term = filters.search;
    b = b.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone_normalized.ilike.%${term}%,email.ilike.%${term}%`);
  }
  return b;
}

/** Streams every matching lead in bounded pages (never one in-memory
 * array built from an unbounded query) - the same 10k+-row discipline as
 * Phase 9's CDR export. Returns rows already shaped with resolved list
 * names and one flattened column per custom field key. */
async function fetchAllLeadRows(
  supabase: Supabase,
  orgId: string,
  filters: LeadsExportFilters,
): Promise<{ rows: Array<Record<string, unknown>>; columns: ExportColumn<Record<string, unknown>>[] }> {
  const { data: customFieldDefs } = await supabase
    .from('lead_custom_fields')
    .select('field_key, field_label')
    .eq('organization_id', orgId);
  const customColumns: Array<{ key: string; header: string }> = (customFieldDefs ?? []).map((f: any) => ({
    key: f.field_key,
    header: f.field_label,
  }));

  const PAGE = 1000;
  const allRows: Array<Record<string, unknown>> = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let builder = supabase.from('leads').select(LEAD_SELECT_COLUMNS);
    builder = applyLeadFilters(builder, orgId, filters);
    builder = builder.order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await builder;
    if (error) throw error;
    const batch = (data as Record<string, any>[]) ?? [];
    allRows.push(...batch);
    if (batch.length < PAGE) break;
    page += 1;
  }

  const listIds = Array.from(new Set(allRows.map((l) => l.lead_list_id).filter(Boolean)));
  let listNames = new Map<string, string>();
  if (listIds.length > 0) {
    const { data: lists } = await supabase.from('lead_lists').select('id, name').in('id', listIds as string[]);
    listNames = new Map((lists ?? []).map((l: any) => [l.id, l.name]));
  }

  const rows = allRows.map((lead) => {
    const customFields = (lead.custom_fields as Record<string, unknown>) ?? {};
    const row: Record<string, unknown> = {
      ...lead,
      lead_list_name: lead.lead_list_id ? listNames.get(lead.lead_list_id as string) ?? null : null,
    };
    for (const col of customColumns) row[col.key] = customFields[col.key] ?? null;
    return row;
  });

  return { rows, columns: [...BASE_COLUMNS, ...customColumns] };
}

export async function queueLeadsExport(
  orgId: string,
  userId: string,
  type: ExportType,
  filters: LeadsExportFilters,
  entityReference: Record<string, unknown> | null = null,
): Promise<ExportRecord> {
  const record = await queueExportJob(orgId, userId, type, filters, entityReference);
  scheduleExportJob(record, type === 'leads_xlsx', async (exportRow) => {
    const { rows, columns } = await fetchAllLeadRows(getSupabaseAdmin(), exportRow.organization_id, exportRow.filters as LeadsExportFilters);
    return { rows, columns, sheetName: 'Leads' };
  });
  return record;
}
