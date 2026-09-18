/**
 * Phase 14: SMS campaign message export (master spec section 40's
 * tracked fields - recipient, rendered content, status, timestamps,
 * error). Scoped to one campaign (`entity_reference.smsCampaignId`),
 * running through the same Phase 9 export engine every other export
 * type uses.
 */
import { getSupabaseAdmin } from '../../lib/supabase.js';
import type { ExportColumn } from './writers.js';
import { queueExportJob, scheduleExportJob } from './runner.js';
import type { ExportRecord, ExportType } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface SmsMessagesExportFilters {
  status?: string;
}

const SMS_MESSAGE_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: 'lead_name', header: 'Lead' },
  { key: 'phone_e164', header: 'Recipient Phone' },
  { key: 'rendered_body', header: 'Message' },
  { key: 'status', header: 'Status' },
  { key: 'provider_message_id', header: 'Provider Message ID' },
  { key: 'error', header: 'Error' },
  { key: 'sent_at', header: 'Sent At' },
  { key: 'delivered_at', header: 'Delivered At' },
  { key: 'created_at', header: 'Created At' },
];

async function fetchAllSmsMessageRows(
  supabase: Supabase,
  smsCampaignId: string,
  filters: SmsMessagesExportFilters,
): Promise<Array<Record<string, unknown>>> {
  const PAGE = 1000;
  const allRows: Array<Record<string, any>> = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let builder = supabase
      .from('sms_messages')
      .select('id, lead_id, phone_e164, rendered_body, status, provider_message_id, error, sent_at, delivered_at, created_at')
      .eq('sms_campaign_id', smsCampaignId);
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

export async function queueSmsMessagesExport(
  orgId: string,
  userId: string,
  type: ExportType,
  smsCampaignId: string,
  filters: SmsMessagesExportFilters,
): Promise<ExportRecord> {
  const record = await queueExportJob(orgId, userId, type, filters, { smsCampaignId });
  scheduleExportJob(record, type === 'sms_messages_xlsx', async (exportRow) => {
    const rows = await fetchAllSmsMessageRows(
      getSupabaseAdmin(),
      (exportRow.entity_reference as { smsCampaignId: string }).smsCampaignId,
      exportRow.filters as SmsMessagesExportFilters,
    );
    return { rows, columns: SMS_MESSAGE_COLUMNS, sheetName: 'SMS Messages' };
  });
  return record;
}
