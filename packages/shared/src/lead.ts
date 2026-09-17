/**
 * Phase 2: leads, lead lists, DNC and import job types shared between the
 * backend and frontend. See supabase/migrations/00000000000010-16 for the
 * schema these mirror.
 */

/** The full Phase 51 lead state machine, seeded now even though nothing
 * drives a lead through most of these states until the dialer phases. */
export type LeadStatus =
  | 'NEW'
  | 'QUEUED'
  | 'CALLED'
  | 'CONNECTED'
  | 'VOICEMAIL'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'DNC'
  | 'CALLBACK'
  | 'TRANSFERRED'
  | 'COMPLETED'
  | 'FAILED';

export const LEAD_STATUSES: LeadStatus[] = [
  'NEW',
  'QUEUED',
  'CALLED',
  'CONNECTED',
  'VOICEMAIL',
  'NO_ANSWER',
  'BUSY',
  'DNC',
  'CALLBACK',
  'TRANSFERRED',
  'COMPLETED',
  'FAILED',
];

export interface LeadList {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadListWithCounts extends LeadList {
  lead_count: number;
}

export interface Lead {
  id: string;
  organization_id: string;
  lead_list_id: string | null;
  first_name: string;
  last_name: string;
  company: string | null;
  phone_original: string;
  phone_normalized: string;
  country_code: string;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  status: LeadStatus;
  attempts: number;
  last_called_at: string | null;
  last_disposition: string | null;
  next_callback_at: string | null;
  is_dnc: boolean;
  dnc_reason: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LeadWithLists extends Lead {
  lists: { id: string; name: string }[];
}

/** Shape returned by GET /leads (list endpoint) - includes the primary
 * list's name so the table doesn't need a second round trip per row. */
export interface LeadListRow extends Lead {
  lead_list_name: string | null;
}

export interface LeadCustomField {
  id: string;
  organization_id: string;
  field_key: string;
  field_label: string;
  field_type: 'text' | 'number' | 'date' | 'boolean';
  created_at: string;
}

export type DncSource = 'manual' | 'caller_request' | 'import';

export interface DncEntry {
  id: string;
  organization_id: string | null;
  phone_normalized: string;
  reason: string | null;
  source: DncSource;
  created_by: string | null;
  created_at: string;
}

export type ImportJobStatus =
  | 'pending'
  | 'parsing'
  | 'validating'
  | 'ready_for_review'
  | 'committing'
  | 'completed'
  | 'failed';

export interface ImportJob {
  id: string;
  organization_id: string;
  lead_list_id: string;
  file_name: string;
  file_storage_path: string;
  status: ImportJobStatus;
  column_mapping: Record<string, string>;
  error_message: string | null;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  dnc_rows: number;
  imported_rows: number;
  error_report_path: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type ImportRowResult = 'valid' | 'invalid' | 'duplicate' | 'dnc';

export interface ImportJobRow {
  id: string;
  import_job_id: string;
  row_number: number;
  raw_data: Record<string, unknown>;
  result: ImportRowResult;
  error_message: string | null;
  phone_normalized: string | null;
  lead_id: string | null;
  created_at: string;
}

/** Mappable target fields a CSV/XLSX column can be assigned to on import. */
export const IMPORTABLE_LEAD_FIELDS = [
  'first_name',
  'last_name',
  'company',
  'phone',
  'email',
  'address',
  'city',
  'state',
  'zip',
  'country',
] as const;
export type ImportableLeadField = (typeof IMPORTABLE_LEAD_FIELDS)[number];

/** A "select all matching filter" bulk action target - lets the frontend
 * express "every lead matching these filters" without enumerating
 * potentially 10k+ ids. */
export interface LeadFilter {
  lead_list_id?: string | null;
  status?: LeadStatus;
  is_dnc?: boolean;
  search?: string;
}

export type LeadBulkSelection = { ids: string[] } | { filter: LeadFilter };

export type LeadBulkActionType = 'delete' | 'move_to_list' | 'assign_list';

export interface LeadBulkActionInput {
  action: LeadBulkActionType;
  selection: LeadBulkSelection;
  lead_list_id?: string;
}

export interface LeadBulkActionResult {
  action: LeadBulkActionType;
  affected: number;
}
