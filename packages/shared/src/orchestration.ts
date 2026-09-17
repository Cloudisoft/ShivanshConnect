/**
 * Phase 6: call orchestration (Vapi + pipecat) types shared between the
 * backend and frontend. See supabase/migrations/00000000000028-29 for the
 * schema these mirror.
 */

export const CALL_ENGINES = ['vapi', 'pipecat'] as const;
export type CallEngine = (typeof CALL_ENGINES)[number];

export const CALL_ENGINE_LABELS: Record<CallEngine, string> = {
  vapi: 'Vapi (managed)',
  pipecat: 'Pipecat (self-hosted)',
};

/** Phase 50's call-state-machine enum. apps/backend/src/lib/orchestration/
 * callStateMachine.ts is the single source of truth for which transitions
 * between these are valid - this list is just the full set of values. */
export const CALL_STATUSES = [
  'queued',
  'dialing',
  'ringing',
  'answered',
  'in_progress',
  'voicemail',
  'answering_machine',
  'transfer_pending',
  'transferring',
  'transferred',
  'transfer_failed',
  'completed',
  'failed',
  'dnc',
  'cancelled',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export type CallDirection = 'inbound' | 'outbound';
export type TransferStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed';

export interface Call {
  id: string;
  organization_id: string;
  engine: CallEngine;
  vapi_call_id: string | null;
  pipecat_call_id: string | null;
  ai_agent_id: string;
  ai_agent_version_id: string;
  campaign_id: string | null;
  lead_id: string | null;
  phone_number_id: string;
  direction: CallDirection;
  customer_number: string;
  status: CallStatus;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  talk_duration_seconds: number | null;
  ended_reason: string | null;
  transfer_destination_e164: string | null;
  transfer_status: TransferStatus | null;
  cost: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallEvent {
  id: string;
  call_id: string;
  organization_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export type WebhookProvider = 'vapi' | 'pipecat' | 'twilio' | 'telnyx';
export type WebhookProcessingStatus = 'pending' | 'processing' | 'processed' | 'failed';

export interface WebhookEvent {
  id: string;
  organization_id: string | null;
  provider: WebhookProvider;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  received_at: string;
  processed_at: string | null;
  processing_status: WebhookProcessingStatus;
  error: string | null;
  retry_count: number;
  created_at: string;
}

export type VapiCredentialStatus = 'not_connected' | 'connected' | 'error';

export interface VapiCredentialSummary {
  status: VapiCredentialStatus;
  masked_credential: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  webhook_url: string | null;
}

/** organization_settings.settings key used for the org's default call
 * engine (Settings > Integrations > Call Engine). Read/written through the
 * existing generic PATCH /organizations/me { settings } merge - no
 * dedicated endpoint needed. */
export const DEFAULT_CALL_ENGINE_SETTINGS_KEY = 'default_call_engine';
