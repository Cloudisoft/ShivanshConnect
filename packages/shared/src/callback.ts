/**
 * Phase 8: callback scheduler (master spec sections 17, 53). See
 * supabase/migrations/00000000000033_phase8_dispositions_callbacks.sql for
 * the schema this mirrors.
 */

export const CALLBACK_STATUSES = ['scheduled', 'pending', 'calling', 'completed', 'cancelled', 'failed'] as const;
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

export const CALLBACK_STATUS_LABELS: Record<CallbackStatus, string> = {
  scheduled: 'Scheduled',
  pending: 'Pending',
  calling: 'Calling',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/** Terminal callback statuses - once reached the callback never fires
 * again through the dispatcher. */
export const CALLBACK_TERMINAL_STATUSES: CallbackStatus[] = ['completed', 'cancelled', 'failed'];

export interface Callback {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  lead_id: string;
  phone_e164: string;
  scheduled_at: string;
  timezone: string;
  reason: string | null;
  notes: string | null;
  assigned_to: string | null; // a user id, or the literal string 'ai'
  status: CallbackStatus;
  source_call_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
