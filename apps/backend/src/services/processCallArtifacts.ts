/**
 * Phase 9: real artifact ingestion (master spec sections 21/22).
 *
 * Triggered from services/callTerminalHandler.ts (setImmediate, same
 * fire-and-forget-but-tracked async pattern every prior phase's
 * ingestion services use - importLeads.ts, processKnowledgeDocument.ts,
 * campaignDispatcher.ts) whenever a call lands on a terminal status other
 * than 'cancelled' (a cancelled call never actually took place - there is
 * nothing to fetch).
 *
 * Never fabricates anything: a provider that has no transcript/recording
 * for this call (a failed/very-short call, or an engine that simply
 * doesn't expose one) is recorded as an honest `status: 'failed'` row
 * with a clear `failure_reason` - never silently skipped and never a
 * placeholder value.
 *
 * Recording durability: `getRecording()` only ever returns the
 * PROVIDER's own URL, which may be short-lived/access-controlled. This
 * module actually fetches those bytes and re-stores them via the
 * existing Phase 4 StorageAdapter (never just persists the provider URL
 * as if it were a permanent reference) - see lib/storage/index.ts.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { getStorageAdapter } from '../lib/storage/index.js';
import {
  OrchestrationProviderError,
  OrchestrationProviderNotConfiguredError,
  type CallArtifacts,
  type TranscriptSegmentRaw,
} from '../lib/orchestration/index.js';
import { generateCallSummary } from './generateCallSummary.js';
import { evaluateCall } from './evaluateCall.js';
import { aggregateAgentImprovements } from './aggregateAgentImprovements.js';
import { hasLiveTranscriptSegments } from './liveTranscriptIngestion.js';
import { resolveProviderForCall } from '../lib/orchestration/resolveProvider.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Splits a flat "AI: ...\nCaller: ...\nAI: ..." style transcript string
 * into ordered segments by speaker prefix. This is the fallback path when
 * the engine has no structured per-message timing to offer (see
 * TranscriptSegmentRaw's header comment) - every segment's start_ms/end_ms
 * is left at 0/null rather than inventing spacing, since no real timing
 * data exists to derive it from. Lines that don't start with a recognized
 * speaker label are appended to the previous segment's text (a
 * continuation line), never dropped and never assigned a fabricated new
 * speaker. */
export function parseFlatTranscript(text: string): TranscriptSegmentRaw[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const segments: TranscriptSegmentRaw[] = [];
  const speakerPattern = /^(AI|Assistant|Bot|User|Caller|Customer)\s*:\s*(.*)$/i;

  for (const line of lines) {
    const match = line.match(speakerPattern);
    if (match) {
      const label = match[1].toLowerCase();
      const speaker: 'ai' | 'caller' = label === 'user' || label === 'caller' || label === 'customer' ? 'caller' : 'ai';
      segments.push({ speaker, startMs: 0, endMs: null, text: match[2] });
    } else if (segments.length > 0) {
      segments[segments.length - 1].text += ` ${line}`;
    }
  }
  return segments;
}

/** Assigns each segment its own start_ms when the source gave no real
 * per-segment timing (the flat-text fallback) - spreads segments evenly
 * across the call's own real duration_seconds so the "00:00 / 00:04 / ..."
 * UI format is at least internally consistent with the actual call length,
 * WITHOUT claiming any single segment boundary is a real measured
 * timestamp. When every raw segment already carries real timing (the
 * Vapi/pipecat structured path), this is a pure no-op. */
function estimateTimingIfMissing(segments: TranscriptSegmentRaw[], durationSeconds: number | null): TranscriptSegmentRaw[] {
  const allZero = segments.every((s) => s.startMs === 0);
  if (!allZero || segments.length === 0 || !durationSeconds || durationSeconds <= 0) return segments;
  const stepMs = Math.floor((durationSeconds * 1000) / segments.length);
  return segments.map((s, i) => ({ ...s, startMs: i * stepMs }));
}

/** Manual "select then insert-or-update" upsert on a table's UNIQUE
 * (call_id) column - real supabase-js has a native .upsert(), but the
 * in-memory test harness (test/fakeSupabase.ts) does not implement it, so
 * every table this module writes to goes through this instead, exactly
 * mirroring the existing manual-upsert pattern services/dispositionEngine.
 * ts's assignDispositionForCall() already established for call_dispositions. */
async function upsertByCallId(supabase: Supabase, table: 'call_transcripts' | 'call_recordings', callId: string, values: Record<string, unknown>): Promise<Record<string, any>> {
  const { data: existing } = await supabase.from(table).select('id').eq('call_id', callId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from(table).update(values).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from(table).insert({ call_id: callId, ...values }).select('*').single();
  if (error) throw error;
  return data;
}

async function upsertTranscriptFailed(supabase: Supabase, call: Record<string, any>, reason: string): Promise<void> {
  await upsertByCallId(supabase, 'call_transcripts', call.id, { organization_id: call.organization_id, status: 'failed', failure_reason: reason, full_text: null });
}

async function upsertRecordingFailed(supabase: Supabase, call: Record<string, any>, reason: string): Promise<void> {
  await upsertByCallId(supabase, 'call_recordings', call.id, { organization_id: call.organization_id, status: 'failed', failure_reason: reason });
}

async function ingestTranscript(supabase: Supabase, call: Record<string, any>, artifacts: CallArtifacts): Promise<boolean> {
  if (!artifacts.transcript || artifacts.transcript.trim().length === 0) {
    await upsertTranscriptFailed(supabase, call, 'This call has no transcript available from the orchestration engine (e.g. it never connected, or the engine reported none).');
    return false;
  }

  const rawSegments = artifacts.segments ?? parseFlatTranscript(artifacts.transcript);
  const segments = estimateTimingIfMissing(rawSegments, call.duration_seconds ?? null);

  // Phase 10: this fetch is now a RECONCILIATION/BACKFILL step, not the
  // sole source of segments - services/liveTranscriptIngestion.ts may
  // already have written real per-utterance rows for this call as they
  // arrived DURING the call (see that module's header comment). If any
  // live segments exist, they are trusted as-is and this step only
  // upgrades the transcript's own status/full_text/source_url - it never
  // deletes or duplicates what live ingestion already wrote. Only when
  // NO live segment ever arrived (this engine/call never delivered
  // incremental transcript events) does this fall back to the original
  // Phase 9 behavior: a full parse-and-insert from the post-call
  // artifact, which is safe to (re-)run idempotently since nothing else
  // could have raced to insert segments for this transcript_id.
  const alreadyLive = await hasLiveTranscriptSegments(supabase, call.id);

  const transcriptValues: Record<string, unknown> = {
    organization_id: call.organization_id,
    status: 'ready',
    failure_reason: null,
    source_url: artifacts.transcriptUrl ?? null,
  };
  // Only overwrite full_text from the post-call artifact when nothing was
  // built up live - live ingestion's own full_text (the real, incremental
  // concatenation of segments as they actually arrived) is the better
  // record of what was actually said, never clobbered by a backfill.
  if (!alreadyLive) transcriptValues.full_text = artifacts.transcript;

  const transcript = await upsertByCallId(supabase, 'call_transcripts', call.id, transcriptValues);

  if (!alreadyLive) {
    // Idempotent re-run (e.g. a webhook replay) of the backfill path
    // only: clear any previously backfilled segments for this transcript
    // before re-inserting, so a second run never duplicates rows.
    await supabase.from('call_transcript_segments').delete().eq('transcript_id', transcript.id);

    if (segments.length > 0) {
      await supabase.from('call_transcript_segments').insert(
        segments.map((s, index) => ({
          transcript_id: transcript.id,
          call_id: call.id,
          organization_id: call.organization_id,
          speaker: s.speaker,
          segment_index: index,
          start_ms: s.startMs,
          end_ms: s.endMs,
          text: s.text,
        })),
      );
    }
  }

  return true;
}

/** Infers an audio format from a URL's extension or an HTTP response's
 * content-type - never assumes MP3 when the source is actually WAV, and
 * defaults to mp3 only when nothing else indicates otherwise (Vapi's own
 * default recording format). */
function inferFormat(url: string, contentType: string | null): 'mp3' | 'wav' {
  if (contentType?.includes('wav')) return 'wav';
  if (contentType?.includes('mpeg') || contentType?.includes('mp3')) return 'mp3';
  if (/\.wav($|\?)/i.test(url)) return 'wav';
  return 'mp3';
}

async function ingestRecording(supabase: Supabase, call: Record<string, any>, artifacts: CallArtifacts): Promise<void> {
  if (!artifacts.recordingUrl) {
    await upsertRecordingFailed(supabase, call, 'No recording is available for this call.');
    return;
  }

  await upsertByCallId(supabase, 'call_recordings', call.id, {
    organization_id: call.organization_id,
    status: 'downloading',
    provider_recording_url: artifacts.recordingUrl,
    failure_reason: null,
  });

  let res: Response;
  try {
    res = await fetch(artifacts.recordingUrl);
  } catch (err) {
    await upsertRecordingFailed(supabase, call, `Failed to reach the provider's recording URL: ${err instanceof Error ? err.message : 'unknown error'}.`);
    return;
  }
  if (!res.ok) {
    await upsertRecordingFailed(supabase, call, `The provider's recording URL returned ${res.status}.`);
    return;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    await upsertRecordingFailed(supabase, call, "The provider's recording URL returned an empty file.");
    return;
  }

  const format = inferFormat(artifacts.recordingUrl, res.headers.get('content-type'));
  const storage = getStorageAdapter();
  const stored = await storage.putObject(`recordings/${call.organization_id}/${call.id}.${format}`, buffer, format === 'wav' ? 'audio/wav' : 'audio/mpeg');

  await upsertByCallId(supabase, 'call_recordings', call.id, {
    organization_id: call.organization_id,
    provider_recording_url: artifacts.recordingUrl,
    storage_path: stored.path,
    format,
    duration_seconds: call.duration_seconds ?? null,
    size_bytes: buffer.length,
    status: 'ready',
    failure_reason: null,
  });
}

/** The one entry point services/callTerminalHandler.ts schedules
 * (setImmediate) for every terminal call other than 'cancelled'. Never
 * throws to its caller - every failure is captured as an honest failed
 * row on the relevant table, and a genuinely unexpected error (e.g. the
 * call row itself vanished) is logged, not silently swallowed. */
export async function processCallArtifacts(callId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: call, error } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (error || !call) {
    // eslint-disable-next-line no-console
    console.error('processCallArtifacts: call not found', callId, error);
    return;
  }

  let artifacts: CallArtifacts;
  try {
    const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
    if (!providerCallId) {
      await upsertTranscriptFailed(supabase, call, 'This call never reached the orchestration engine (no provider call id).');
      await upsertRecordingFailed(supabase, call, 'This call never reached the orchestration engine (no provider call id).');
      return;
    }
    const provider = await resolveProviderForCall(supabase, call);
    artifacts = await provider.getArtifacts(providerCallId);
  } catch (err) {
    const message =
      err instanceof OrchestrationProviderNotConfiguredError || err instanceof OrchestrationProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Unknown error fetching call artifacts.';
    await upsertTranscriptFailed(supabase, call, message);
    await upsertRecordingFailed(supabase, call, message);
    return;
  }

  const transcriptReady = await ingestTranscript(supabase, call, artifacts);
  await ingestRecording(supabase, call, artifacts);

  if (transcriptReady) {
    // Fire-and-forget, same async pattern as this module's own caller -
    // a summary failure (or no LLM configured) never blocks/fails
    // transcript or recording ingestion, which have already committed.
    setImmediate(() => {
      generateCallSummary(callId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('generateCallSummary failed for call', callId, err);
      });
    });

    // Phase 11: AI call evaluator + improvement mining (spec sections
    // 24/49/86). Also fire-and-forget, and deliberately independent of
    // the summary above (one LLM feature failing must never block
    // another) - see services/evaluateCall.ts's header comment for the
    // exact skip conditions (no LLM configured / no disposition yet /
    // etc.), all honest no-ops, never a fabricated evaluation.
    setImmediate(() => {
      evaluateCall(callId)
        .then((evaluation) => {
          if (!evaluation) return;
          return aggregateAgentImprovements(callId, evaluation);
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('evaluateCall/aggregateAgentImprovements failed for call', callId, err);
        });
    });
  }
}
