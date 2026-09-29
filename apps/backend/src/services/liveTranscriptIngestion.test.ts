import { describe, expect, it, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import { clearLiveTranscriptCache, hasLiveTranscriptSegments, ingestLiveTranscriptSegment } from './liveTranscriptIngestion.js';
import { transcriptEventBus } from '../lib/transcriptEventBus.js';

const CALL = { id: 'call-1', organization_id: 'org-A' };

describe('ingestLiveTranscriptSegment (Phase 10)', () => {
  // Every test below creates a fresh, empty fakeSupabase instance but
  // reuses the same CALL.id - the module-level per-call cache
  // (services/liveTranscriptIngestion.ts's transcriptCache, the
  // performance fix that avoids a DB round trip on every utterance after
  // the first) would otherwise leak stale state from one test into the
  // next against that test's own fresh tables.
  beforeEach(() => {
    clearLiveTranscriptCache('call-1');
  });

  it('creates the call_transcripts row on the first segment and assigns sequential segment_index values', async () => {
    const { supabase: rawSupabase, tables } = createFakeSupabase();
    const supabase = rawSupabase as any;

    const first = await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'ai', text: 'Hello John, this is Acme calling.', startMs: 0, endMs: 1200 });
    const second = await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'caller', text: 'Yes, who is this?', startMs: 1300, endMs: 2000 });

    expect(first?.segment_index).toBe(0);
    expect(second?.segment_index).toBe(1);

    const transcripts = tables.call_transcripts.filter((t: any) => t.call_id === 'call-1');
    expect(transcripts).toHaveLength(1); // exactly one transcript row per call, never duplicated
    expect(transcripts[0].full_text).toBe('AI: Hello John, this is Acme calling.\nCaller: Yes, who is this?');

    const segments = tables.call_transcript_segments.filter((s: any) => s.call_id === 'call-1');
    expect(segments).toHaveLength(2);
  });

  it('never inserts a blank/whitespace-only utterance', async () => {
    const { supabase: rawSupabase, tables } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const result = await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'ai', text: '   ', startMs: 0, endMs: null });
    expect(result).toBeNull();
    expect(tables.call_transcript_segments).toHaveLength(0);
  });

  it('dedupes via the (transcript_id, segment_index) unique index - a duplicate index is rejected, never silently double-counted', async () => {
    const { supabase: rawSupabase, tables } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const transcript = { id: 't-1', call_id: 'call-1', organization_id: 'org-A', status: 'pending', full_text: null };
    tables.call_transcripts.push(transcript as any);

    await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'ai', text: 'First.', startMs: 0, endMs: null });
    // Simulates two concurrent deliveries both observing count=0 (an
    // extremely narrow race this module's header comment documents as
    // an accepted, rare limitation) - the fakeSupabase harness enforces
    // the same UNIQUE (transcript_id, segment_index) constraint Postgres
    // does, so forcing a collision here proves the safety net exists.
    const dupe = tables.call_transcript_segments[0];
    const { error } = await supabase.from('call_transcript_segments').insert({ ...dupe, id: 'seg-dupe' });
    expect(error).toBeTruthy();
    expect(error.code).toBe('23505');
  });

  it('hasLiveTranscriptSegments reports false until a segment exists, true afterwards', async () => {
    const { supabase: rawSupabase } = createFakeSupabase();
    const supabase = rawSupabase as any;
    expect(await hasLiveTranscriptSegments(supabase, 'call-1')).toBe(false);
    await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'caller', text: 'Hi.', startMs: 0, endMs: null });
    expect(await hasLiveTranscriptSegments(supabase, 'call-1')).toBe(true);
  });

  it('lines arriving at the same moment all get stored, each with its own segment_index (none lost)', async () => {
    const { supabase: rawSupabase, tables } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const results = await Promise.all(
      ['One.', 'Two.', 'Three.', 'Four.'].map((text, i) => ingestLiveTranscriptSegment(supabase, CALL, { speaker: i % 2 ? 'caller' : 'ai', text, startMs: i * 1000, endMs: null })),
    );
    expect(results.map((r) => r?.segment_index).sort()).toEqual([0, 1, 2, 3]);
    expect(tables.call_transcripts.filter((t: any) => t.call_id === 'call-1')).toHaveLength(1);
    expect(tables.call_transcript_segments.filter((s: any) => s.call_id === 'call-1')).toHaveLength(4);
  });

  it('pushes the line to Live Monitor before it is written to the database', async () => {
    const { supabase: rawSupabase, tables } = createFakeSupabase();
    const supabase = rawSupabase as any;
    await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'ai', text: 'Warm-up.', startMs: 0, endMs: null });
    let storedWhenEmitted = -1;
    const handler = () => {
      storedWhenEmitted = tables.call_transcript_segments.filter((s: any) => s.call_id === 'call-1').length;
    };
    transcriptEventBus.on('segment', handler);
    try {
      await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'caller', text: 'Right away.', startMs: 1000, endMs: null });
    } finally {
      transcriptEventBus.off('segment', handler);
    }
    expect(storedWhenEmitted).toBe(1); // only the earlier line was stored yet
  });

  it('emits a TRANSCRIPT_UPDATED-feeding segment event on transcriptEventBus for exactly this call/org', async () => {
    const { supabase: rawSupabase } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const received: any[] = [];
    const handler = (e: any) => received.push(e);
    transcriptEventBus.on('segment', handler);
    try {
      await ingestLiveTranscriptSegment(supabase, CALL, { speaker: 'ai', text: 'Hello!', startMs: 0, endMs: null });
    } finally {
      transcriptEventBus.off('segment', handler);
    }
    expect(received).toHaveLength(1);
    expect(received[0].callId).toBe('call-1');
    expect(received[0].organizationId).toBe('org-A');
    expect(received[0].segment.text).toBe('Hello!');
  });
});
