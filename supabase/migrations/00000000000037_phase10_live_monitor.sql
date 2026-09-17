-- Phase 10: Live Monitor - Listen, Whisper, Barge, Live Transcript, Transfer
-- (master spec sections 18/19/54).
--
-- No new tables are required for the real-time transport itself - the WS
-- broadcaster (apps/backend/src/ws/liveMonitor.ts) is built entirely on
-- top of Phase 8's in-process `callEventBus` and Phase 9's existing
-- `call_transcript_segments` table (its (transcript_id, segment_index)
-- unique index, added in 00000000000035, is exactly the dedupe key live
-- ingestion needs - see services/liveTranscriptIngestion.ts). This
-- migration adds only the one column genuinely new state requires:
--
--   calls.transfer_initiated_by - 'ai' when the assistant itself
--     initiated the transfer (Vapi's own forwardingPhoneNumber flow, or
--     pipecat's tool-driven transfer), 'supervisor' when a human
--     triggered it from the Live Monitor's manual Transfer action
--     (routes/liveMonitor.ts). Every supervisor-triggered listen/whisper/
--     barge/transfer/end action is additionally always audit-logged (see
--     AUDIT_ACTIONS.CALL_*_SUPERVISOR* / CALL_LISTEN_STARTED etc in
--     packages/shared/src/audit.ts) - this column exists so the `calls`
--     row itself also carries the answer to "who started the transfer
--     that is/was in progress" without a join, for the Live Monitor UI.
alter table public.calls
  add column if not exists transfer_initiated_by text
    check (transfer_initiated_by is null or transfer_initiated_by in ('ai', 'supervisor'));

comment on column public.calls.transfer_initiated_by is
  'Who most recently initiated this call''s in-progress/last transfer attempt: ai (engine-driven) or supervisor (Live Monitor manual action).';
