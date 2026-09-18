import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The email-channel equivalent of lib/leadHelpers.ts's isOnDncList/
 * findDncMatches, against email_suppressions instead of dnc_entries.
 * Deliberately a separate check - suppressing an email address must
 * never suppress that same contact's phone DNC status and vice versa
 * (spec section 60's opt-out handling is per-channel; see
 * supabase/migrations/00000000000046's header comment).
 */
export async function isEmailSuppressed(supabase: SupabaseClient, organizationId: string, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const { data, error } = await supabase.from('email_suppressions').select('id, organization_id').eq('email', normalized);
  if (error) throw error;
  return (data ?? []).some((row: any) => row.organization_id === null || row.organization_id === organizationId);
}
