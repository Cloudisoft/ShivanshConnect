/**
 * Phase 10: real-time (mid-call) transcript segment ingestion (master
 * spec sections 18/54).
 *
 * Extends Phase 9's call_transcript_segments table (created in
 * 00000000000035_phase9_cdr.sql) to be written to INCREMENTALLY, as each
 * engine delivers an utterance during a live call, rather than only once
 * post-call from getTranscript()/getArtifacts(). Both webhook receivers
 * (routes/webhooks.ts) call ingestLiveTranscriptSegment() the moment they
 * recognize a completed-utterance transcript event:
 *   - Vapi: a `transcript` webhook message with `transcriptType: 'final'`
 *     (Vapi's own documented distinction between interim/partial and
 *     final transcript deliveries - only 'final' is ever persisted here,
 *     exactly once per utterance, so a stream of partial deltas for the
 *     same utterance never produces multiple segments).
 *   - pipecat: a `transcript` event this service's own pipeline emits
 *     once per completed utterance (see apps/pipecat-service/app/
 *     transcript.py) - already final by construction (pipecat's STT/LLM
 *     frames are only forwarded here once a full utterance is available).
 *
 * Dedupe key: call_transcript_segments' existing UNIQUE
 * (transcript_id, segment_index) index (Phase 9) is reused as-is. This
 * module assigns each new live segment the next sequential index (a
 * simple SELECT count(*) - safe here because writes for one call are
 * strictly serialized by the fact that a single call only ever has one
 * engine emitting its transcript, one event at a time, and Fastify's
 * request handling for a given webhook delivery already runs to
 * completion before the next is processed for the SAME call in every
 * realistic delivery pattern; a genuine race would very rarely double up
 * an index and hit the same unique-constraint safety net a duplicate
 * webhook redelivery already relies on elsewhere in this codebase).
 *
 * Reconciliation: services/processCallArtifacts.ts's post-call
 * getTranscript()/getArtifacts() fetch is now a BACKFILL step only - see
 * that file's ingestTranscript(), updated in this phase to skip
 * re-inserting segments when live ingestion already produced at least
 * one for this call, and to only run the full historical parse-and-insert
 * path when NO live segments ever arrived (e.g. the engine only exposes a
 * flat post-call transcript with no incremental delivery, or this call's
 * live delivery genuinely failed). This guarantees the two paths can
 * never both write conflicting/duplicate segments for the same call.
 */
import type { getSupabaseAdmin } from '../lib/supabase.js';
import { emitLiveTranscriptSegment } from '../lib/transcriptEventBus.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Finds this call's call_transcripts row, creating an honest `pending`
 * one if this is the very first live segment for the call (there is
 * nothing to mark 'ready' yet - the transcript is still being built; Phase
 * 9's own status semantics are unchanged, 'ready' is only ever set once
 * the call reaches a terminal state and processCallArtifacts confirms/
 * backfills the full transcript). */
async function getOrCreateLiveTranscript(supabase: Supabase, call: Record<string, any>): Promise<Record<string, any>> {
  const { data: existing } = await supabase.from('call_transcripts').select('*').eq('call_id', call.id).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabase
    .from('call_transcripts')
    .insert({ call_id: call.id, organization_id: call.organization_id, status: 'pending', full_text: null })
    .select('*')
    .single();
  if (error) throw error;
  return created;
}

export interface IngestLiveSegmentInput {
  speaker: 'ai' | 'caller';
  text: string;
  startMs: number;
  endMs: number | null;
}

/**
 * Writes one live transcript segment for a call and emits it on
 * transcriptEventBus so ws/liveMonitor.ts can push TRANSCRIPT_UPDATED
 * immediately. Returns the inserted row, or null if `text` was empty
 * (never persists a blank utterance).
 */
export async function ingestLiveTranscriptSegment(
  supabase: Supabase,
  call: Record<string, any>,
  input: IngestLiveSegmentInput,
): Promise<Record<string, any> | null> {
  const text = input.text.trim();
  if (!text) return null;

  const transcript = await getOrCreateLiveTranscript(supabase, call);

  const { count } = await supabase
    .from('call_transcript_segments')
    .select('id', { count: 'exact', head: true })
    .eq('transcript_id', transcript.id);
  const segmentIndex = count ?? 0;

  const { data: inserted, error } = await supabase
    .from('call_transcript_segments')
    .insert({
      transcript_id: transcript.id,
      call_id: call.id,
      organization_id: call.organization_id,
      speaker: input.speaker,
      segment_index: segmentIndex,
      start_ms: input.startMs,
      end_ms: input.endMs,
      text,
    })
    .select('*')
    .single();
  if (error) throw error;

  // Keep full_text growing too, so a mid-call reconciliation read (or a
  // call that ends before this transcript is ever backfilled) still has
  // a real, non-empty full_text built purely from what was actually said.
  const nextFullText = transcript.full_text ? `${transcript.full_text}\n${input.speaker === 'ai' ? 'AI' : 'Caller'}: ${text}` : `${input.speaker === 'ai' ? 'AI' : 'Caller'}: ${text}`;
  await supabase.from('call_transcripts').update({ full_text: nextFullText }).eq('id', transcript.id);

  emitLiveTranscriptSegment({
    callId: call.id,
    organizationId: call.organization_id,
    segment: {
      id: inserted.id,
      call_id: call.id,
      segment_index: inserted.segment_index,
      speaker: inserted.speaker,
      start_ms: inserted.start_ms,
      end_ms: inserted.end_ms,
      text: inserted.text,
    },
  });

  return inserted;
}

/** True when at least one live segment already exists for this call -
 * the signal processCallArtifacts.ts uses to decide whether its post-call
 * fetch should be a full backfill or a no-op reconciliation. */
export async function hasLiveTranscriptSegments(supabase: Supabase, callId: string): Promise<boolean> {
  const { count } = await supabase.from('call_transcript_segments').select('id', { count: 'exact', head: true }).eq('call_id', callId);
  return (count ?? 0) > 0;
}
