import type { SupabaseClient } from '@supabase/supabase-js';

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
  const { data, error } = await supabase
    .from('dnc_entries')
    .select('phone_normalized, organization_id')
    .in('phone_normalized', phoneNumbers);
  if (error) throw error;
  const matches = new Set<string>();
  for (const row of data ?? []) {
    if (row.organization_id === null || row.organization_id === organizationId) {
      matches.add(row.phone_normalized);
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
  const { data, error } = await supabase
    .from('leads')
    .select('phone_normalized')
    .eq('organization_id', organizationId)
    .in('phone_normalized', phoneNumbers);
  if (error) throw error;
  return new Set((data ?? []).map((row: any) => row.phone_normalized));
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
