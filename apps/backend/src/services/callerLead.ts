/**
 * The lead record behind a live call. Outbound calls always have one; an
 * inbound call from an unknown number starts without one, and gets it the
 * moment the caller gives their details (save_caller_details) or asks for
 * a callback (schedule_callback needs a lead to call back).
 */
import { normalizePhoneNumber } from '../lib/phone.js';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface CallerDetails {
  first_name?: string;
  last_name?: string;
  phone?: string;
  email?: string;
  purpose?: string;
  notes?: string;
}

function clean(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseCallerDetails(args: Record<string, unknown>): CallerDetails {
  return {
    first_name: clean(args.first_name, 100),
    last_name: clean(args.last_name, 100),
    phone: clean(args.phone, 40),
    email: clean(args.email, 254)?.toLowerCase(),
    purpose: clean(args.purpose, 500),
    notes: clean(args.notes, 1000),
  };
}

/** Returns the call's lead id, creating (or matching by phone) a lead for
 * an inbound caller who has none yet, and linking it to the call. */
export async function ensureLeadForCall(supabase: Supabase, call: Record<string, any>, details: CallerDetails = {}): Promise<string | null> {
  if (call.lead_id) return call.lead_id as string;

  const fromDetails = details.phone ? normalizePhoneNumber(details.phone) : null;
  const fromCaller = call.customer_number ? normalizePhoneNumber(String(call.customer_number)) : null;
  const phone = fromDetails?.valid ? fromDetails : fromCaller?.valid ? fromCaller : null;
  if (!phone) return null;

  const { data: existing } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', call.organization_id)
    .eq('phone_normalized', phone.e164)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let leadId = existing?.id as string | undefined;
  if (!leadId) {
    const { data: created, error } = await supabase
      .from('leads')
      .insert({
        organization_id: call.organization_id,
        first_name: details.first_name ?? '',
        last_name: details.last_name ?? '',
        phone_original: phone.original,
        phone_normalized: phone.e164,
        country_code: phone.countryCode,
        email: details.email ?? null,
        custom_fields: { source: 'inbound_call', ...(details.purpose ? { purpose: details.purpose } : {}) },
      })
      .select('id')
      .single();
    if (error) throw error;
    leadId = created.id as string;
  }

  await supabase.from('calls').update({ lead_id: leadId }).eq('id', call.id).is('lead_id', null);
  call.lead_id = leadId;
  return leadId;
}

/** save_caller_details: fills in / updates the caller's lead record.
 * Returns a short confirmation for the model. */
export async function saveCallerDetails(supabase: Supabase, call: Record<string, any>, details: CallerDetails): Promise<string> {
  const leadId = await ensureLeadForCall(supabase, call, details);
  if (!leadId) return "Couldn't save the details - no valid phone number for this caller yet. Ask for the best number to reach them.";

  const { data: lead } = await supabase.from('leads').select('id, custom_fields').eq('id', leadId).maybeSingle();
  const update: Record<string, unknown> = {};
  if (details.first_name) update.first_name = details.first_name;
  if (details.last_name) update.last_name = details.last_name;
  if (details.email) update.email = details.email;
  const extra: Record<string, unknown> = {};
  if (details.purpose) extra.purpose = details.purpose;
  if (details.notes) extra.caller_notes = details.notes;
  if (details.phone) {
    const alt = normalizePhoneNumber(details.phone);
    if (alt.valid) extra.alternate_phone = alt.e164;
  }
  if (Object.keys(extra).length > 0) update.custom_fields = { ...((lead?.custom_fields as Record<string, unknown>) ?? {}), ...extra };
  if (Object.keys(update).length > 0) {
    const { error } = await supabase.from('leads').update(update).eq('id', leadId);
    if (error) throw error;
  }
  return 'Saved.';
}
