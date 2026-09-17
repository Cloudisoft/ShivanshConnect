/**
 * Phase 9: CDR, transcripts, recordings, AI call summaries (master spec
 * sections 21/22/23). See supabase/migrations/00000000000035_phase9_cdr.sql
 * for the schema these mirror.
 */

export type TranscriptStatus = 'pending' | 'ready' | 'failed';
export type RecordingStatus = 'pending' | 'downloading' | 'ready' | 'failed';
export type TranscriptSpeaker = 'ai' | 'caller';
export type ExportType = 'cdr_csv' | 'cdr_xlsx';
export type ExportStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface CallTranscript {
  id: string;
  call_id: string;
  organization_id: string;
  full_text: string | null;
  status: TranscriptStatus;
  failure_reason: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallTranscriptSegment {
  id: string;
  transcript_id: string;
  call_id: string;
  organization_id: string;
  speaker: TranscriptSpeaker;
  segment_index: number;
  start_ms: number;
  end_ms: number | null;
  text: string;
  created_at: string;
}

export interface CallRecording {
  id: string;
  call_id: string;
  organization_id: string;
  provider_recording_url: string | null;
  storage_path: string | null;
  format: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  status: RecordingStatus;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallSummary {
  id: string;
  call_id: string;
  organization_id: string;
  summary: string;
  key_points: string[];
  customer_intent: string | null;
  objections: string[] | null;
  questions: string[] | null;
  next_action: string | null;
  outcome: string | null;
  llm_provider: string;
  llm_model: string;
  generated_at: string;
  created_at: string;
}

/** One row of the CDR list per spec section 21's exact field list. This is
 * a JOIN-derived, read-shaped record - never persisted as its own table. */
export interface CdrRow {
  call_id: string;
  provider_call_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  lead_id: string | null;
  lead_name: string | null;
  caller_number: string;
  destination_number: string;
  direction: 'inbound' | 'outbound';
  ai_agent_id: string;
  ai_agent_name: string | null;
  voice_id: string | null;
  voice_name: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  talk_duration_seconds: number | null;
  status: string;
  disposition_code: string | null;
  disposition_name: string | null;
  ended_reason: string | null;
  transfer_status: string | null;
  has_recording: boolean;
  has_transcript: boolean;
  has_summary: boolean;
  cost: number | null;
  engine: 'vapi' | 'pipecat';
  created_at: string;
}

export interface CdrDetail extends CdrRow {
  transcript: CallTranscript | null;
  transcript_segments: CallTranscriptSegment[];
  recording: (CallRecording & { playback_url: string | null }) | null;
  summary: CallSummary | null;
}

export interface ExportRecord {
  id: string;
  organization_id: string;
  type: ExportType;
  filters: Record<string, unknown>;
  status: ExportStatus;
  file_storage_path: string | null;
  row_count: number | null;
  failure_reason: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ExportWithDownload extends ExportRecord {
  download_url: string | null;
}
