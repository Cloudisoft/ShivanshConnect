import { areaCodeOf } from '../lib/localPresence.js';
import { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface CallerIdRoutingResult {
  phoneNumber: Record<string, any>;
  enabled: boolean;
  selectedFromPool: boolean;
  matchType: 'disabled' | 'area_code' | 'pool_fallback' | 'default_fallback' | 'routing_error';
}

/**
 * Opt-in caller-ID routing. The feature is disabled unless
 * organization_settings.settings.caller_id_routing_enabled === true.
 * The caller_id_pool table is seeded from eligible registered numbers; its
 * enabled flag allows individual numbers to be excluded. Any routing/configuration error falls back to the number
 * the existing flow already selected, so the add-on cannot block existing
 * calls when the optional feature is unavailable.
 */
export async function resolveCallerIdPhoneNumber(
  supabase: Supabase,
  organizationId: string,
  defaultPhoneNumber: Record<string, any>,
  destinationE164: string,
): Promise<CallerIdRoutingResult> {
  const unchanged = (enabled: boolean, matchType: CallerIdRoutingResult['matchType']): CallerIdRoutingResult => ({
    phoneNumber: defaultPhoneNumber,
    enabled,
    selectedFromPool: false,
    matchType,
  });

  try {
    const { data: settingsRow, error: settingsError } = await supabase
      .from('organization_settings')
      .select('settings')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (settingsError) return unchanged(false, 'routing_error');
    const settings = (settingsRow?.settings ?? {}) as Record<string, unknown>;
    if (settings.caller_id_routing_enabled !== true) return unchanged(false, 'disabled');

    const destinationAreaCode = areaCodeOf(destinationE164);
    const { data: selectedId, error: selectionError } = await supabase.rpc('select_caller_id_from_pool', {
      p_organization_id: organizationId,
      p_destination_area_code: destinationAreaCode,
    });

    if (selectionError || typeof selectedId !== 'string') {
      return unchanged(true, selectionError ? 'routing_error' : 'default_fallback');
    }

    const { data: selectedNumber, error: numberError } = await supabase
      .from('phone_numbers')
      .select('*')
      .eq('id', selectedId)
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .contains('capabilities', { voice_outbound: true })
      .maybeSingle();

    if (numberError || !selectedNumber) return unchanged(true, 'default_fallback');

    const localMatch = destinationAreaCode !== null && areaCodeOf(selectedNumber.phone_number) === destinationAreaCode;
    return {
      phoneNumber: selectedNumber,
      enabled: true,
      selectedFromPool: true,
      matchType: localMatch ? 'area_code' : 'pool_fallback',
    };
  } catch {
    // This is deliberately fail-open to the pre-existing selected number:
    // caller-ID routing is an optional add-on, not a new call dependency.
    return unchanged(false, 'routing_error');
  }
}
