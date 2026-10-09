/**
 * Delete call log entries from CDR, per request: select one call, a few,
 * or every call matching the filters, and delete them.
 *
 * Deleting a call removes its record together with its transcript,
 * recording (the stored audio file too), summary, outcome, evaluation and
 * events (all cascade from calls in the database). Campaign leads and
 * callbacks that pointed at it keep their place (the reference is
 * cleared). A call that is still live (ringing, talking, transferring) is
 * never deleted - it is skipped and counted.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { getStorageAdapter } from '../lib/storage/index.js';
import { chunkArray } from '../lib/arrayChunk.js';
import { ACTIVE_CALL_STATUSES } from './campaignDispatcher.js';
import { fetchCdrCallsPage, type CdrFilters } from './cdrQuery.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Ids per .in() query - keeps each request URL well under PostgREST's limit. */
const ID_QUERY_BATCH_SIZE = 200;
/** Most calls one delete may remove ("all matching" included). */
export const MAX_CALLS_PER_DELETE = 20_000;

export interface DeleteCallsResult {
  deleted: number;
  skipped_live: number;
  not_found: number;
}

/** Every call id matching the CDR filters (newest first), up to the cap. */
export async function callIdsMatchingFilters(supabase: Supabase, orgId: string, filters: CdrFilters): Promise<string[]> {
  const ids: string[] = [];
  const pageSize = 1000;
  for (let page = 1; ids.length < MAX_CALLS_PER_DELETE; page += 1) {
    const { calls } = await fetchCdrCallsPage(supabase, orgId, filters, page, pageSize);
    ids.push(...calls.map((c) => c.id as string));
    if (calls.length < pageSize) break;
  }
  return ids.slice(0, MAX_CALLS_PER_DELETE);
}

export async function deleteCalls(supabase: Supabase, orgId: string, callIds: string[]): Promise<DeleteCallsResult> {
  const requested = Array.from(new Set(callIds));
  const found: Array<{ id: string; status: string }> = [];
  for (const batch of chunkArray(requested, ID_QUERY_BATCH_SIZE)) {
    const { data, error } = await supabase.from('calls').select('id, status').eq('organization_id', orgId).in('id', batch);
    if (error) throw error;
    found.push(...((data as Array<{ id: string; status: string }> | null) ?? []));
  }

  const live = new Set(ACTIVE_CALL_STATUSES);
  const deletable = found.filter((c) => !live.has(c.status)).map((c) => c.id);
  const result: DeleteCallsResult = {
    deleted: 0,
    skipped_live: found.length - deletable.length,
    not_found: requested.length - found.length,
  };
  if (deletable.length === 0) return result;

  // Stored audio files are looked up before the rows that point at them go.
  const storagePaths: string[] = [];
  for (const batch of chunkArray(deletable, ID_QUERY_BATCH_SIZE)) {
    const { data, error } = await supabase.from('call_recordings').select('storage_path').in('call_id', batch);
    if (error) throw error;
    for (const r of (data as Array<{ storage_path: string | null }> | null) ?? []) {
      if (r.storage_path) storagePaths.push(r.storage_path);
    }
  }

  for (const batch of chunkArray(deletable, ID_QUERY_BATCH_SIZE)) {
    // Org-scoped again here, and never a call that went live in between.
    const { data, error } = await supabase
      .from('calls')
      .delete()
      .eq('organization_id', orgId)
      .in('id', batch)
      .not('status', 'in', `(${ACTIVE_CALL_STATUSES.join(',')})`)
      .select('id');
    if (error) throw error;
    result.deleted += ((data as unknown[] | null) ?? []).length;
  }
  result.skipped_live += deletable.length - result.deleted;

  // Audio files: best effort - a file that can't be removed must not undo
  // or fail a delete that already happened.
  const storage = getStorageAdapter();
  for (const path of storagePaths) {
    try {
      await storage.deleteObject(path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('deleteCalls: could not remove recording file', path, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
