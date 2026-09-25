import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray } from './arrayChunk.js';

/** Real production incident: a large paste-numbers/import batch built an
 * `.in('phone_normalized', [...])` query whose URL exceeded PostgREST's
 * ~16KB header limit (a 17124-character URL from ~450 E.164 numbers in
 * one unbatched .in() call), failing the whole add/import with a bare
 * "fetch failed" / HeadersOverflowError. 200 E.164 numbers (max 16 chars
 * each, plus comma/URL-encoding overhead) keeps this well under that
 * limit with room to spare for the rest of the request's headers. */
const PHONE_IN_QUERY_BATCH_SIZE = 200;

/**
 * Is `phoneNormalized` on the DNC list for `organizationId` - either a
 * global (organization_id null) entry or one scoped to this org?
 */
export async function isOnDncList(
  supabase: SupabaseClient,
  organizationId: string,
  phoneNormalized: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('dnc_entries')
    .select('id, organization_id')
    .eq('phone_normalized', phoneNormalized);
  if (error) throw error;
  return (data ?? []).some((row: any) => row.organization_id === null || row.organization_id === organizationId);
}

/**
 * Bulk variant of isOnDncList for import/bulk-add flows so we don't issue
 * one query per row. Returns the set of normalized phones (from
 * `phoneNumbers`) that are suppressed for this org.
 */
export async function findDncMatches(
  supabase: SupabaseClient,
  organizationId: string,
  phoneNumbers: string[],
): Promise<Set<string>> {
  if (phoneNumbers.length === 0) return new Set();
  const matches = new Set<string>();
  const results = await Promise.all(
    chunkArray(phoneNumbers, PHONE_IN_QUERY_BATCH_SIZE).map((batch) =>
      supabase.from('dnc_entries').select('phone_normalized, organization_id').in('phone_normalized', batch),
    ),
  );
  for (const { data, error } of results) {
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.organization_id === null || row.organization_id === organizationId) {
        matches.add(row.phone_normalized);
      }
    }
  }
  return matches;
}

/**
 * Existing leads' phone_normalized values for this org, restricted to
 * `phoneNumbers`, used to detect duplicates on single/bulk add and import.
 */
export async function findExistingLeadPhones(
  supabase: SupabaseClient,
  organizationId: string,
  phoneNumbers: string[],
): Promise<Set<string>> {
  if (phoneNumbers.length === 0) return new Set();
  const existing = new Set<string>();
  const results = await Promise.all(
    chunkArray(phoneNumbers, PHONE_IN_QUERY_BATCH_SIZE).map((batch) =>
      supabase.from('leads').select('phone_normalized').eq('organization_id', organizationId).in('phone_normalized', batch),
    ),
  );
  for (const { data, error } of results) {
    if (error) throw error;
    for (const row of (data ?? []) as any[]) existing.add(row.phone_normalized);
  }
  return existing;
}

/**
 * When a number is added to the DNC list, any existing lead for that org
 * with the same normalized phone must be flagged is_dnc = true (per
 * Phase 2 spec: "adding a number to DNC must also flag any existing
 * matching leads.is_dnc = true for that org").
 */
export async function flagExistingLeadsAsDnc(
  supabase: SupabaseClient,
  organizationId: string,
  phoneNormalized: string,
  reason: string | null,
): Promise<number> {
  const { data, error } = await supabase
    .from('leads')
    .update({ is_dnc: true, dnc_reason: reason ?? 'Added to Do Not Call list', status: 'DNC' })
    .eq('organization_id', organizationId)
    .eq('phone_normalized', phoneNormalized)
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}
