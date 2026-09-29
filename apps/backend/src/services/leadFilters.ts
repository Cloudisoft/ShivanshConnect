/**
 * The ONE place lead filters are applied - the Leads list, "select all
 * matching" bulk actions and the leads export all go through it, so a
 * bulk delete or export can never cover different leads than the list
 * the user is looking at.
 */
export interface LeadFilter {
  lead_list_id?: string | null;
  status?: string;
  is_dnc?: boolean;
  search?: string;
  /** Case-insensitive match on the lead's state (e.g. "PA"). */
  state?: string;
  /** "never": no call placed yet; "called": at least one call. */
  called?: 'never' | 'called';
  /** Only leads with a callback scheduled. */
  has_callback?: boolean;
  created_from?: string;
  created_to?: string;
}

/** Strips characters PostgREST's or()/ilike syntax treats specially. */
function safeTerm(value: string): string {
  return value.replace(/[%,()*\\]/g, ' ').trim();
}

export function applyLeadFilters<B>(builder: B, filter: LeadFilter): B {
  let b = builder as any;
  if (filter.lead_list_id) b = b.eq('lead_list_id', filter.lead_list_id);
  if (filter.status) b = b.eq('status', filter.status);
  if (filter.is_dnc !== undefined) b = b.eq('is_dnc', filter.is_dnc);
  if (filter.search) {
    const digitsOnly = filter.search.replace(/\D/g, '');
    const term = digitsOnly.length >= 3 ? digitsOnly : safeTerm(filter.search);
    if (term) b = b.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone_normalized.ilike.%${term}%,email.ilike.%${term}%`);
  }
  if (filter.state) {
    const state = safeTerm(filter.state);
    if (state) b = b.ilike('state', state);
  }
  if (filter.called === 'never') b = b.is('last_called_at', null);
  if (filter.called === 'called') b = b.not('last_called_at', 'is', null);
  if (filter.has_callback) b = b.not('next_callback_at', 'is', null);
  if (filter.created_from) b = b.gte('created_at', filter.created_from);
  if (filter.created_to) b = b.lte('created_at', filter.created_to);
  return b as B;
}
