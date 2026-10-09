/**
 * Reset leads for another round of dialing, per request: from Leads / Lead
 * Lists, reset a few selected leads, all of them, or a filtered set (e.g.
 * only Voicemail or Call Connected) - never Disconnected, Not in Service,
 * DNC or Not Interested, and never a lead that is on a call right now.
 *
 * A reset lead is fresh again in every campaign it is attached to
 * (campaign_leads back to pending, attempts 0, no wait) and shows as NEW;
 * its last outcome and call history stay on record.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { NEVER_RESET_OUTCOMES as NEVER_RESET_OUTCOME_NAMES } from '@shivanshconnect/shared';
import { chunkArray } from '../lib/arrayChunk.js';
import { ACTIVE_CALL_STATUSES } from './campaignDispatcher.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Ids per .in() query - keeps each request URL well under PostgREST's limit. */
const ID_QUERY_BATCH_SIZE = 200;

async function selectInBatches<T>(query: (batch: string[]) => PromiseLike<{ data: unknown; error: unknown }>, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (const batch of chunkArray(ids, ID_QUERY_BATCH_SIZE)) {
    const { data, error } = await query(batch);
    if (error) throw error;
    out.push(...((data as T[] | null) ?? []));
  }
  return out;
}

/** Last outcomes that are never reset (leads.last_disposition holds the
 * disposition's display name). */
export const NEVER_RESET_OUTCOMES = new Set(NEVER_RESET_OUTCOME_NAMES);

/** campaign_leads statuses of a lead mid-call. */
const IN_FLIGHT_CAMPAIGN_LEAD_STATUSES = ['queued', 'dialing', 'ringing', 'connected', 'in_progress', 'transferring'];

export interface ResetLeadRow {
  id: string;
  status: string | null;
  is_dnc: boolean | null;
  last_disposition: string | null;
}

export type ResetSkipReason = 'excluded_outcome' | 'dnc';

/** Pure rule: why a lead may not be reset, or null when it may. */
export function resetBlocker(lead: ResetLeadRow): ResetSkipReason | null {
  if (lead.is_dnc || lead.status === 'DNC') return 'dnc';
  if (lead.last_disposition && NEVER_RESET_OUTCOMES.has(lead.last_disposition)) return 'excluded_outcome';
  return null;
}

export interface ResetLeadsResult {
  reset: number;
  skipped_excluded: number;
  skipped_on_call: number;
  campaign_entries_reset: number;
}

export async function resetLeads(supabase: Supabase, orgId: string, leadIds: string[]): Promise<ResetLeadsResult> {
  const leads = await selectInBatches<ResetLeadRow>(
    (batch) => supabase.from('leads').select('id, status, is_dnc, last_disposition').eq('organization_id', orgId).in('id', batch),
    leadIds,
  );

  const allowed: string[] = [];
  let skippedExcluded = 0;
  for (const lead of leads) {
    if (resetBlocker(lead)) skippedExcluded += 1;
    else allowed.push(lead.id);
  }

  const onCall = new Set(
    (
      await selectInBatches<{ lead_id: string }>(
        (batch) => supabase.from('calls').select('lead_id').in('lead_id', batch).in('status', ACTIVE_CALL_STATUSES),
        allowed,
      )
    ).map((c) => c.lead_id),
  );
  const toReset = allowed.filter((id) => !onCall.has(id));

  let campaignEntries = 0;
  for (const batch of chunkArray(toReset, ID_QUERY_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('campaign_leads')
      .update({ status: 'pending', attempt_count: 0, next_eligible_at: null, final_disposition: null })
      .in('lead_id', batch)
      .not('status', 'in', `(${IN_FLIGHT_CAMPAIGN_LEAD_STATUSES.join(',')})`)
      .select('id');
    if (error) throw error;
    campaignEntries += (data ?? []).length;

    const { error: leadError } = await supabase.from('leads').update({ status: 'NEW' }).eq('organization_id', orgId).in('id', batch);
    if (leadError) throw leadError;
  }

  return { reset: toReset.length, skipped_excluded: skippedExcluded, skipped_on_call: onCall.size, campaign_entries_reset: campaignEntries };
}
