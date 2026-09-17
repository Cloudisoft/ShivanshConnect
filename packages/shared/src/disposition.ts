/**
 * Phase 8: the deterministic disposition engine (master spec section 20).
 * See supabase/migrations/00000000000033_phase8_dispositions_callbacks.sql
 * for the schema these mirror, and
 * apps/backend/src/services/dispositionEngine.ts for the actual rules
 * engine that assigns these - never randomized, never manually assigned by
 * default UI action.
 */

/** System-default disposition codes seeded for every organization. An org
 * may additionally define its own custom codes (dispositions.is_system =
 * false) - this list is only the fixed set the engine itself knows how to
 * derive automatically. */
export const SYSTEM_DISPOSITION_CODES = [
  'CALL_CONNECTED',
  'DISCONNECTED',
  'DNC',
  'ANSWERING_MACHINE',
  'VOICEMAIL',
  'NOT_INTERESTED',
  'HUNG_UP',
  'TRANSFERRED',
  'CALL_DISCONNECTED_IN_TRANSFER',
] as const;
export type SystemDispositionCode = (typeof SYSTEM_DISPOSITION_CODES)[number];

export const SYSTEM_DISPOSITION_SEED: ReadonlyArray<{ code: SystemDispositionCode; name: string }> = [
  { code: 'CALL_CONNECTED', name: 'Call Connected' },
  { code: 'DISCONNECTED', name: 'Disconnected' },
  { code: 'DNC', name: 'DNC' },
  { code: 'ANSWERING_MACHINE', name: 'Answering Machine' },
  { code: 'VOICEMAIL', name: 'Voicemail' },
  { code: 'NOT_INTERESTED', name: 'Not Interested' },
  { code: 'HUNG_UP', name: 'Hung Up' },
  { code: 'TRANSFERRED', name: 'Transferred' },
  { code: 'CALL_DISCONNECTED_IN_TRANSFER', name: 'Call Disconnected in Transfer' },
];

export interface Disposition {
  id: string;
  organization_id: string | null;
  code: string;
  name: string;
  is_system: boolean;
  created_at: string;
}

export type DispositionSource = 'engine' | 'manual';

export interface CallDisposition {
  id: string;
  call_id: string;
  organization_id: string;
  disposition_id: string;
  disposition_source: DispositionSource;
  disposition_confidence: number | null;
  disposition_reason: string | null;
  assigned_at: string;
  assigned_by: string | null;
}

export interface CallDispositionWithDetails extends CallDisposition {
  disposition_code: string;
  disposition_name: string;
}
