/**
 * Recovers call recordings that failed to download earlier because the
 * provider stored them in private storage (Vapi returned raw bucket URLs
 * that answer 400 "InvalidArgument: Authorization"). Those recordings
 * still exist and are now fetched through the provider's authenticated
 * download (see processCallArtifacts.ts), so this sweep re-runs the
 * recording step for recent failed rows, a few at a time and newest
 * first, so every call in CDR ends up with a playable recording.
 *
 * It also converts any recording still stored as WAV (saved before
 * recordings were stored as MP3) to MP3.
 *
 * Each call is attempted at most once per process, so a call that truly
 * has no recording (never connected) is not retried forever.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { convertStoredRecordingToMp3, reingestRecording } from './processCallArtifacts.js';

const SWEEP_INTERVAL_MS = Number.parseInt(process.env.RECORDING_BACKFILL_SWEEP_INTERVAL_MS ?? '', 10) || 30 * 1000;
const BATCH_SIZE = 5;
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const RECOVERABLE_REASONS = [
  "The provider's recording URL returned 400.",
  'No recording is available for this call.',
];

const attempted = new Set<string>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runRecordingBackfillTick(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('call_recordings')
    .select('call_id')
    .eq('status', 'failed')
    .in('failure_reason', RECOVERABLE_REASONS)
    .gte('created_at', new Date(Date.now() - LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;

  const batch = (data ?? []).map((r) => r.call_id as string).filter((id) => !attempted.has(id)).slice(0, BATCH_SIZE);
  let recovered = 0;
  for (const callId of batch) {
    attempted.add(callId);
    if (await reingestRecording(callId, { retry: false })) recovered += 1;
  }

  const { data: wavRows, error: wavError } = await supabase
    .from('call_recordings')
    .select('id')
    .eq('status', 'ready')
    .eq('format', 'wav')
    .order('created_at', { ascending: false })
    .limit(200);
  if (wavError) throw wavError;
  const wavBatch = (wavRows ?? []).map((r) => r.id as string).filter((id) => !attempted.has(id)).slice(0, BATCH_SIZE);
  for (const id of wavBatch) {
    attempted.add(id);
    if (await convertStoredRecordingToMp3(id)) recovered += 1;
  }
  return recovered;
}

async function runTickOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runRecordingBackfillTick();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('recordingBackfillSweep tick failed', err);
  } finally {
    running = false;
  }
}

export function startRecordingBackfillSweep(): void {
  if (intervalHandle) return;
  void runTickOnce();
  intervalHandle = setInterval(runTickOnce, SWEEP_INTERVAL_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopRecordingBackfillSweep(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
