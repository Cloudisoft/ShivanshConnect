/**
 * The ONE place Voices and DIDs list filters are applied - the list
 * routes and their "select all matching" bulk actions both go through
 * these, so a bulk action never covers different rows than the list the
 * user is looking at (same approach as services/leadFilters.ts).
 */
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Strips characters PostgREST's or()/ilike syntax treats specially. */
export function safeTerm(value: string): string {
  return value.replace(/[%,()*\\]/g, ' ').trim();
}

export interface VoiceFilter {
  provider_key?: string;
  language?: string;
  gender?: string;
  /** Defaults to active: hidden voices only when asked for. */
  status?: 'active' | 'inactive';
  is_cloned?: boolean;
  search?: string;
}

export function applyVoiceFilters<B>(builder: B, f: VoiceFilter): B {
  let b = builder as any;
  if (f.provider_key) b = b.eq('provider_key', f.provider_key);
  if (f.language) b = b.eq('language', f.language);
  if (f.gender) b = b.eq('gender', f.gender);
  if (f.is_cloned !== undefined) b = b.eq('is_cloned', f.is_cloned);
  if (f.search) {
    const term = safeTerm(f.search);
    if (term) b = b.or(`name.ilike.%${term}%,provider_voice_id.ilike.%${term}%`);
  }
  b = b.eq('status', f.status ?? 'active');
  return b as B;
}

export interface PhoneNumberFilter {
  provider_key?: string;
  status?: string;
  assigned_agent_id?: string;
  unassigned?: boolean;
  search?: string;
  inbound?: 'answering' | 'not_set_up';
}

export function applyPhoneNumberFilters<B>(builder: B, f: PhoneNumberFilter): B {
  let b = builder as any;
  if (f.provider_key) b = b.eq('provider_key', f.provider_key);
  if (f.status) b = b.eq('status', f.status);
  if (f.assigned_agent_id) b = b.eq('assigned_agent_id', f.assigned_agent_id);
  if (f.unassigned) b = b.is('assigned_agent_id', null);
  if (f.search) {
    const raw = safeTerm(f.search);
    const digits = raw.replace(/\D/g, '');
    const term = digits.length >= 3 ? digits : raw;
    if (term) b = b.or(`phone_number.ilike.%${term}%,friendly_name.ilike.%${raw}%`);
  }
  if (f.inbound === 'answering') b = b.not('vapi_phone_number_id', 'is', null);
  if (f.inbound === 'not_set_up') b = b.is('vapi_phone_number_id', null);
  return b as B;
}

const ID_PAGE = 1000;
export const MAX_BULK_IDS = 20_000;

/** Ids of every row in `table` of this org matching `apply` - fetched in
 * bounded pages (ids only), capped at MAX_BULK_IDS. */
export async function collectMatchingIds(supabase: Supabase, table: string, orgId: string, apply: (builder: any) => any): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; ; page += 1) {
    const q = apply(supabase.from(table).select('id').eq('organization_id', orgId))
      .order('id', { ascending: true })
      .range(page * ID_PAGE, page * ID_PAGE + ID_PAGE - 1);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await q;
    if (error) throw error;
    const batch = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    ids.push(...batch);
    if (batch.length < ID_PAGE || ids.length >= MAX_BULK_IDS) break;
  }
  return ids.slice(0, MAX_BULK_IDS);
}

/** Splits ids into chunks small enough for a PostgREST `in` filter URL. */
export function chunk<T>(items: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
