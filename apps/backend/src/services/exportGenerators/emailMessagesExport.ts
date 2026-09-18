/**
 * Phase 14: email campaign message export (master spec section 41's
 * tracked fields - recipient, rendered content, status, timestamps,
 * error). Scoped to one campaign (`entity_reference.emailCampaignId`),
 * running through the same Phase 9 export engine every other export
 * type uses. Honest about what's actually tracked: delivered/bounced/
 * replied remain valid statuses in the schema for a future transactional-
 * provider integration, but this build never writes them (see
 * services/emailDispatcher.ts) - the export simply reflects whatever
 * status is really stored, same as the UI.
 */
import { getSupabaseAdmin } from '../../lib/supabase.js';
import type { ExportColumn } from './writers.js';
import { queueExportJob, scheduleExportJob } from './runner.js';
import type { ExportRecord, ExportType } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface EmailMessagesExportFilters {
  status?: string;
}

const EMAIL_MESSAGE_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: 'lead_name', header: 'Lead' },
  { key: 'recipient_email', header: 'Recipient Email' },
  { key: 'rendered_subject', header: 'Subject' },
  { key: 'rendered_html', header: 'Rendered Body (HTML)' },
  { key: 'status', header: 'Status' },
  { key: 'error', header: 'Error' },
  { key: 'sent_at', header: 'Sent At' },
  { key: 'created_at', header: 'Created At' },
];

async function fetchAllEmailMessageRows(
  supabase: Supabase,
  emailCampaignId: string,
  filters: EmailMessagesExportFilters,
): Promise<Array<Record<string, unknown>>> {
  const PAGE = 1000;
  const allRows: Array<Record<string, any>> = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let builder = supabase
      .from('email_messages')
      .select('id, lead_id, recipient_email, rendered_subject, rendered_html, status, error, sent_at, created_at')
      .eq('email_campaign_id', emailCampaignId);
    if (filters.status) builder = builder.eq('status', filters.status);
    builder = builder.order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await builder;
    if (error) throw error;
    const batch = data ?? [];
    allRows.push(...batch);
    if (batch.length < PAGE) break;
    page += 1;
  }

  const leadIds = Array.from(new Set(allRows.map((r) => r.lead_id).filter(Boolean)));
  let leadNameById = new Map<string, string | null>();
  if (leadIds.length > 0) {
    const { data: leads } = await supabase.from('leads').select('id, first_name, last_name').in('id', leadIds);
    leadNameById = new Map((leads ?? []).map((l: any) => [l.id, `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || null]));
  }

  return allRows.map((r) => ({ ...r, lead_name: leadNameById.get(r.lead_id) ?? null }));
}

export async function queueEmailMessagesExport(
  orgId: string,
  userId: string,
  type: ExportType,
  emailCampaignId: string,
  filters: EmailMessagesExportFilters,
): Promise<ExportRecord> {
  const record = await queueExportJob(orgId, userId, type, filters, { emailCampaignId });
  scheduleExportJob(record, type === 'email_messages_xlsx', async (exportRow) => {
    const rows = await fetchAllEmailMessageRows(
      getSupabaseAdmin(),
      (exportRow.entity_reference as { emailCampaignId: string }).emailCampaignId,
      exportRow.filters as EmailMessagesExportFilters,
    );
    return { rows, columns: EMAIL_MESSAGE_COLUMNS, sheetName: 'Email Messages' };
  });
  return record;
}
