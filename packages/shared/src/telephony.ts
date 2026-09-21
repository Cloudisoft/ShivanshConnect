/**
 * Phase 5: telephony number provider / phone number types shared between
 * the backend and frontend. See supabase/migrations/00000000000026-27 for
 * the schema these mirror.
 */

export const TELEPHONY_PROVIDER_KEYS = ['twilio', 'telnyx', 'byon'] as const;
export type TelephonyProviderKey = (typeof TELEPHONY_PROVIDER_KEYS)[number];

export const TELEPHONY_PROVIDER_LABELS: Record<TelephonyProviderKey, string> = {
  twilio: 'Twilio',
  telnyx: 'Telnyx',
  byon: 'Bring Your Own Number (BYON)',
};

export type TelephonyProviderCredentialStatus = 'not_connected' | 'connected' | 'error';

export interface TelephonyProviderSummary {
  key: TelephonyProviderKey;
  display_name: string;
  /** True only for BYON - it has no third-party credentials at all, so
   * the "Connect" UI/endpoints don't apply to it. */
  is_manual_only: boolean;
  status: TelephonyProviderCredentialStatus;
  /** Masked preview of the stored secret, e.g. "AC12••••••cd34" - never
   * the raw value. Null when nothing is stored yet, and always null for
   * BYON. */
  masked_credential: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

export type PhoneNumberStatus = 'active' | 'inactive' | 'releasing';

export interface PhoneNumberCapabilities {
  voice_inbound: boolean;
  voice_outbound: boolean;
  sms: boolean;
}

/** A number from the provider's purchasable inventory (GET /phone-numbers/
 * available/:providerKey) - never a number anyone already owns.
 * `monthly_price`/`currency` are null when the provider's API did not
 * return real pricing for this search. */
export interface AvailableNumber {
  phone_number: string;
  friendly_name: string | null;
  locality: string | null;
  region: string | null;
  capabilities: PhoneNumberCapabilities;
  monthly_price: number | null;
  currency: string | null;
}

export interface PhoneNumber {
  id: string;
  organization_id: string;
  provider_key: TelephonyProviderKey;
  provider_number_id: string | null;
  phone_number: string;
  friendly_name: string | null;
  capabilities: PhoneNumberCapabilities;
  status: PhoneNumberStatus;
  assigned_agent_id: string | null;
  assigned_campaign_id: string | null;
  sip_trunk_metadata: { host?: string; username?: string } | null;
  /** Set once this number has been imported into Vapi - null until the
   * first eager sync-on-purchase/import, a manual sync, or the lazy
   * sync-on-first-call. */
  vapi_phone_number_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
