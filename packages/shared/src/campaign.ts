/**
 * Phase 7: campaigns, campaign versions (snapshots), campaign leads,
 * dialing settings. See supabase/migrations/00000000000031-32 for the
 * schema these mirror.
 */

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'stopped',
  'failed',
  'archived',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  stopped: 'Stopped',
  failed: 'Failed',
  archived: 'Archived',
};

export const CAMPAIGN_VERSION_STATUSES = ['draft', 'published', 'archived'] as const;
export type CampaignVersionStatus = (typeof CAMPAIGN_VERSION_STATUSES)[number];

export const CAMPAIGN_LEAD_STATUSES = [
  'pending',
  'queued',
  'dialing',
  'ringing',
  'connected',
  'in_progress',
  'transferring',
  'completed',
  'failed',
  'retry_pending',
  'skipped',
  'dnc',
] as const;
export type CampaignLeadStatus = (typeof CAMPAIGN_LEAD_STATUSES)[number];

/** Terminal campaign_leads statuses - once reached, the dispatcher and
 * webhook processor never move the lead again (spec 11/52). `failed` is
 * terminal too: the webhook processor only ever sets it for a
 * non-retryable ended_reason or once attempt_count has exhausted
 * max_attempts - a genuinely retryable outcome always goes to
 * `retry_pending` instead. Every other status is either still pending
 * dispatch or awaiting a scheduled retry - the invariant this platform
 * guarantees is that every campaign_leads row is always in exactly one of
 * these two buckets, never silently lost. */
export const CAMPAIGN_LEAD_TERMINAL_STATUSES: CampaignLeadStatus[] = ['completed', 'skipped', 'dnc', 'failed'];

export const BACKGROUND_NOISE_OPTIONS = ['off', 'low', 'medium', 'high'] as const;
export type BackgroundNoise = (typeof BACKGROUND_NOISE_OPTIONS)[number];

/** Spec section 8K's exact cooldown preset options (minutes), plus a
 * custom numeric entry the UI still allows. */
export const LEAD_COOLDOWN_PRESETS = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '24 hours', minutes: 1440 },
  { label: '3 days', minutes: 4320 },
  { label: '7 days', minutes: 10080 },
] as const;

export interface Campaign {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  timezone: string;
  calling_window_start: string;
  calling_window_end: string;
  calling_days: number[]; // ISO weekday 1 (Mon) .. 7 (Sun)
  start_date: string | null;
  end_date: string | null;
  concurrency_limit: number;
  calls_per_minute_limit: number | null;
  current_version_id: string | null;
  phone_number_id: string | null;
  transfer_number_e164: string | null;
  voicemail_detection_enabled: boolean;
  voicemail_message: string | null;
  leave_voicemail: boolean;
  lead_cooldown_minutes: number;
  background_noise: BackgroundNoise | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignCallingRulesSnapshot {
  timezone: string;
  calling_window_start: string;
  calling_window_end: string;
  calling_days: number[];
  lead_cooldown_minutes: number;
  voicemail_detection_enabled: boolean;
  voicemail_message: string | null;
  leave_voicemail: boolean;
  background_noise: BackgroundNoise | null;
}

export interface CampaignDispositionRulesSnapshot {
  retry_on: string[]; // ended_reason values that qualify for a retry
  max_attempts: number;
  retry_delay_minutes: number;
}

export interface CampaignVersion {
  id: string;
  campaign_id: string;
  organization_id: string;
  version_number: number;
  prompt: string;
  ai_agent_id: string | null;
  ai_agent_version_id: string | null;
  voice_id: string | null;
  knowledge_base_ids: string[];
  script_id: string | null;
  transfer_number_e164: string | null;
  calling_rules: CampaignCallingRulesSnapshot;
  disposition_rules: CampaignDispositionRulesSnapshot;
  status: CampaignVersionStatus;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CampaignLead {
  id: string;
  campaign_id: string;
  organization_id: string;
  lead_id: string;
  status: CampaignLeadStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  next_eligible_at: string | null;
  last_call_id: string | null;
  final_disposition: string | null;
  added_at: string;
  updated_at: string;
}

export interface CampaignCounts {
  total: number;
  pending: number;
  queued: number;
  dialing: number;
  in_progress: number;
  connected: number;
  completed: number;
  failed: number;
  retry_pending: number;
  skipped: number;
  dnc: number;
  active_calls: number;
}

export interface PreflightError {
  code: string;
  message: string;
}

export interface PreflightResult {
  ready: boolean;
  errors: PreflightError[];
}

export interface DialingSettings {
  id: string;
  organization_id: string;
  is_default: boolean;
  default_concurrency: number;
  max_concurrency: number;
  calls_per_minute: number;
  max_attempts: number;
  retry_delay_minutes: number;
  lead_cooldown_minutes: number;
  calling_hours_start: string;
  calling_hours_end: string;
  voicemail_behavior: 'leave_message' | 'hang_up' | 'retry_later';
  amd_enabled: boolean;
  dnc_behavior: 'skip';
  failed_call_behavior: 'retry' | 'skip';
  busy_behavior: 'retry' | 'skip';
  no_answer_behavior: 'retry' | 'skip';
  created_at: string;
  updated_at: string;
}

/** ended_reason values (from Phase 6's calls.ended_reason, set by the
 * webhook processor) that qualify a lead for an automatic retry, by
 * default - a campaign_versions.disposition_rules.retry_on snapshot can
 * override this list per campaign at publish time. */
export const DEFAULT_RETRYABLE_ENDED_REASONS = [
  'no-answer',
  'busy',
  'customer-did-not-answer',
  'twilio-failed',
  'pipeline-error',
  'assistant-error',
];

/** ended_reason / campaign_leads.status values that mean the lead should
 * NEVER be retried and is excluded from a rotate/reuse re-queue, per the
 * user's explicit rotate-endpoint requirement. */
export const ROTATE_EXCLUDED_DISPOSITIONS = [
  'completed',
  'transferred',
  'dnc',
  'not-interested',
  'hung-up',
  'disconnected',
];
