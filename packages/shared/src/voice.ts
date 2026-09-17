/**
 * Phase 4: voice provider / voice / cloning types shared between the
 * backend and frontend. See supabase/migrations/00000000000024-25 for
 * the schema these mirror.
 */

export const VOICE_PROVIDER_KEYS = ['elevenlabs', 'cartesia', 'omnivoice', 'voxcpm'] as const;
export type VoiceProviderKey = (typeof VOICE_PROVIDER_KEYS)[number];

export const VOICE_PROVIDER_LABELS: Record<VoiceProviderKey, string> = {
  elevenlabs: 'ElevenLabs',
  cartesia: 'Cartesia',
  omnivoice: 'OmniVoice (k2-fsa)',
  voxcpm: 'VoxCPM (OpenBMB)',
};

export type VoiceProviderCredentialStatus = 'not_connected' | 'connected' | 'error';

export interface VoiceProviderSummary {
  key: VoiceProviderKey;
  display_name: string;
  requires_external_hosting: boolean;
  status: VoiceProviderCredentialStatus;
  /** Masked preview of the stored secret, e.g. "sk-l••••••3xyz" - never
   * the raw value. Null when nothing is stored yet. */
  masked_credential: string | null;
  last_verified_at: string | null;
  last_error: string | null;
}

export type VoiceGender = 'male' | 'female' | 'neutral' | 'unknown';
export type VoiceStatus = 'active' | 'inactive';
export type VoiceCloneStatus = 'n/a' | 'pending' | 'processing' | 'ready' | 'failed';

export interface Voice {
  id: string;
  organization_id: string;
  provider_key: VoiceProviderKey;
  provider_voice_id: string;
  name: string;
  gender: VoiceGender | null;
  language: string | null;
  accent: string | null;
  description: string | null;
  status: VoiceStatus;
  is_cloned: boolean;
  source_sample_storage_path: string | null;
  clone_status: VoiceCloneStatus | null;
  consent_confirmed: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Derived from the provider catalog, not a DB column - true for
   * omnivoice/voxcpm so the UI can show a "self-hosted" badge without a
   * second lookup. */
  requires_external_hosting: boolean;
}
