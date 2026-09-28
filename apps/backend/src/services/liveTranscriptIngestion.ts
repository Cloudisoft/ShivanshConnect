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

/** Per-call in-process cache of this live transcript's id, next segment
 * index, and running full_text - performance fix for the dominant source
 * of DB load on an active call: Vapi/pipecat deliver one webhook per
 * finalized utterance, and every one of them used to cost 4 sequential
 * round trips here alone (a SELECT to check the transcript row exists, a
 * SELECT count(*) for the next segment_index, the actual INSERT, and an
 * UPDATE for full_text) on top of the webhook receiver's own round trips -
 * real production evidence: this was measurably contending with every
 * other request (dashboard/campaigns/CDR) for the same DB connection pool
 * during active campaigns. The header comment's own existing "writes for
 * one call are strictly serialized" assumption (already relied on for the
 * count-based segment_index scheme) applies exactly the same way here:
 * within one backend process, this cache is safe. Entries are removed by
 * clearLiveTranscriptCache() once callTerminalHandler.ts confirms the call
 * reached a terminal status, so this never grows unbounded across process
 * uptime. */
const transcriptCache = new Map<string, { transcriptId: string; nextSegmentIndex: number; fullText: string | null }>();

/** Drops this call's cached transcript state - called from
 * callTerminalHandler.ts once a call reaches a terminal status, since no
 * further live segments will ever arrive for it. */
export function clearLiveTranscriptCache(callId: string): void {
  transcriptCache.delete(callId);
}

/** Loads (creating if needed) this call's cache entry - the only path
 * that ever hits the DB for the transcript row/segment count, and only
 * once per call (a cache hit costs nothing). When a call_transcripts row
 * already exists but wasn't cached yet (a process restart mid-call, or
 * some other path created it first), seeds nextSegmentIndex from a real
 * count query rather than assuming 0 - the one case where getting this
 * wrong would corrupt segment ordering / hit the unique constraint. */
async function loadOrCreateCacheEntry(supabase: Supabase, call: Record<string, any>): Promise<{ transcriptId: string; nextSegmentIndex: number; fullText: string | null }> {
  const cached = transcriptCache.get(call.id);
  if (cached) return cached;

  const { data: existing } = await supabase.from('call_transcripts').select('*').eq('call_id', call.id).maybeSingle();
  if (existing) {
    const { count } = await supabase.from('call_transcript_segments').select('id', { count: 'exact', head: true }).eq('transcript_id', existing.id);
    const entry = { transcriptId: existing.id as string, nextSegmentIndex: count ?? 0, fullText: (existing.full_text as string | null) ?? null };
    transcriptCache.set(call.id, entry);
    return entry;
  }

  const { data: created, error } = await supabase
    .from('call_transcripts')
    .insert({ call_id: call.id, organization_id: call.organization_id, status: 'pending', full_text: null })
    .select('*')
    .single();
  if (error) throw error;
  const entry = { transcriptId: created.id as string, nextSegmentIndex: 0, fullText: null };
  transcriptCache.set(call.id, entry);
  return entry;
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

  const entry = await loadOrCreateCacheEntry(supabase, call);
  const segmentIndex = entry.nextSegmentIndex;

  const { data: inserted, error } = await supabase
    .from('call_transcript_segments')
    .insert({
      transcript_id: entry.transcriptId,
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
  const nextFullText = entry.fullText ? `${entry.fullText}\n${input.speaker === 'ai' ? 'AI' : 'Caller'}: ${text}` : `${input.speaker === 'ai' ? 'AI' : 'Caller'}: ${text}`;
  await supabase.from('call_transcripts').update({ full_text: nextFullText }).eq('id', entry.transcriptId);

  // Only committed to the cache once the writes above actually succeeded -
  // a thrown error above must never advance the cached index/full_text
  // past what's really in the database.
  transcriptCache.set(call.id, { transcriptId: entry.transcriptId, nextSegmentIndex: segmentIndex + 1, fullText: nextFullText });

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
