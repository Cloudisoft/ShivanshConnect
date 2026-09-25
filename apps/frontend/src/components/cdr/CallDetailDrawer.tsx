import { useEffect, useMemo, useState } from 'react';
import { X, Play, Pause, Download } from 'lucide-react';
import { EVALUATION_SCORE_CATEGORY_LABELS } from '@shivanshconnect/shared';
import { useCdrDetail, fetchRecordingObjectUrl } from '../../hooks/useCdr';
import { useCallEvaluation } from '../../hooks/useEvaluations';
import { Badge, Button, Input } from '../ui';

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Phase 9: the CDR call detail drawer (spec sections 21/22/23) - full CDR
 * fields, a real transcript viewer (speaker + timestamp + text, with an
 * in-panel search box), a real recording player (play/pause/seek/
 * download), and the AI summary panel or an honest "requires an LLM
 * provider" empty state when no call_summaries row exists.
 */
export function CallDetailDrawer({ callId, onClose }: { callId: string; onClose: () => void }): JSX.Element {
  const { data: detail, isLoading } = useCdrDetail(callId);
  const [transcriptQuery, setTranscriptQuery] = useState('');

  const filteredSegments = useMemo(() => {
    const segments = detail?.transcript_segments ?? [];
    if (!transcriptQuery.trim()) return segments;
    const needle = transcriptQuery.toLowerCase();
    return segments.filter((s: any) => s.text.toLowerCase().includes(needle));
  }, [detail, transcriptQuery]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between border-b border-ink-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold text-ink-900">Call detail</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading && <p className="p-6 text-sm text-ink-500">Loading...</p>}

        {detail && (
          <div className="space-y-6 p-6">
            <section className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Lead" value={detail.lead_name ?? '-'} />
              <Field label="Campaign" value={detail.campaign_name ?? '-'} />
              <Field label="Caller number" value={detail.caller_number || '-'} mono />
              <Field label="Destination number" value={detail.destination_number} mono />
              <Field label="AI Agent" value={detail.ai_agent_name ?? '-'} />
              <Field label="Voice" value={detail.voice_name ?? '-'} />
              <Field label="Engine" value={detail.engine} />
              <Field label="Direction" value={detail.direction} />
              <Field label="Duration" value={detail.duration_seconds != null ? `${detail.duration_seconds}s` : '-'} />
              <Field label="Talk duration" value={detail.talk_duration_seconds != null ? `${detail.talk_duration_seconds}s` : '-'} />
              <Field label="Status" value={<Badge>{detail.status}</Badge>} />
              <Field label="Disposition" value={detail.disposition_name ?? '-'} />
              <Field label="Ended reason" value={detail.ended_reason ?? '-'} />
              <Field label="Transfer status" value={detail.transfer_status ?? '-'} />
              <Field label="Cost" value={detail.cost != null ? `$${Number(detail.cost).toFixed(4)}` : '-'} />
              <Field label="Started" value={detail.started_at ? new Date(detail.started_at).toLocaleString() : '-'} />
              <Field label="Ended" value={detail.ended_at ? new Date(detail.ended_at).toLocaleString() : '-'} />
            </section>

            <section>
              <h3 className="text-sm font-semibold text-ink-900">Recording</h3>
              <RecordingPlayer callId={callId} recording={detail.recording} />
            </section>

            <section>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink-900">Transcript</h3>
                {detail.transcript?.status === 'ready' && (
                  <Input
                    placeholder="Search within transcript..."
                    className="max-w-xs"
                    value={transcriptQuery}
                    onChange={(e) => setTranscriptQuery(e.target.value)}
                  />
                )}
              </div>
              {!detail.transcript || detail.transcript.status === 'failed' ? (
                <p className="mt-2 rounded-md border border-ink-200 bg-ink-50 p-3 text-sm text-ink-500">
                  {detail.transcript?.failure_reason ?? 'No transcript is available for this call.'}
                </p>
              ) : detail.transcript.status === 'pending' ? (
                <p className="mt-2 text-sm text-ink-500">Transcript is still being processed...</p>
              ) : (
                <div className="mt-2 max-h-72 space-y-2 overflow-y-auto rounded-md border border-ink-200 p-3 text-sm">
                  {filteredSegments.length === 0 && <p className="text-ink-500">No matching lines.</p>}
                  {filteredSegments.map((s: any) => (
                    <div key={s.id} className="flex gap-3">
                      <span className="w-12 shrink-0 font-mono text-xs text-ink-400">{formatMs(s.start_ms)}</span>
                      <span className={`w-14 shrink-0 text-xs font-semibold ${s.speaker === 'ai' ? 'text-ink-700' : 'text-blue-700'}`}>
                        {s.speaker === 'ai' ? (detail.voice_name ?? 'AI') : 'Caller'}
                      </span>
                      <span className="text-ink-800">{s.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold text-ink-900">AI Summary</h3>
              {!detail.summary ? (
                <p className="mt-2 rounded-md border border-ink-200 bg-ink-50 p-3 text-sm text-ink-500">
                  Summary requires an LLM provider to be configured.
                </p>
              ) : (
                <div className="mt-2 space-y-3 rounded-md border border-ink-200 p-3 text-sm">
                  <p className="text-ink-800">{detail.summary.summary}</p>
                  {detail.summary.key_points.length > 0 && (
                    <div>
                      <p className="font-semibold text-ink-700">Key points</p>
                      <ul className="ml-4 list-disc text-ink-700">
                        {detail.summary.key_points.map((k: string, i: number) => (
                          <li key={i}>{k}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {detail.summary.customer_intent && <p><span className="font-semibold text-ink-700">Intent: </span>{detail.summary.customer_intent}</p>}
                  {detail.summary.objections && detail.summary.objections.length > 0 && (
                    <div>
                      <p className="font-semibold text-ink-700">Objections</p>
                      <ul className="ml-4 list-disc text-ink-700">
                        {detail.summary.objections.map((o: string, i: number) => (
                          <li key={i}>{o}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {detail.summary.next_action && <p><span className="font-semibold text-ink-700">Next action: </span>{detail.summary.next_action}</p>}
                  {detail.summary.outcome && <p><span className="font-semibold text-ink-700">Outcome: </span>{detail.summary.outcome}</p>}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold text-ink-900">AI Evaluation</h3>
              <EvaluationPanel callId={callId} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Phase 11: the AI Evaluation panel (spec sections 24/86) - overall
 * score, the full sub-score rubric as a simple bar list (per the task
 * brief, not an over-invested visualization), qualitative findings, and
 * an honest "not evaluated"/"evaluation skipped" state when
 * GET /calls/:id/evaluation says so - never a fabricated score. A 403
 * (viewer lacks the agents.manage permission this route requires) is
 * treated the same as "nothing to show" rather than an alarming error,
 * since not every CDR viewer manages agents.
 */
function EvaluationPanel({ callId }: { callId: string }): JSX.Element | null {
  const { data, isLoading, isError } = useCallEvaluation(callId);

  if (isLoading) return <p className="mt-2 text-sm text-ink-500">Loading evaluation...</p>;
  if (isError) return null;
  if (!data) return null;

  if (data.state !== 'evaluated') {
    return <p className="mt-2 rounded-md border border-ink-200 bg-ink-50 p-3 text-sm text-ink-500">{data.reason}</p>;
  }

  const { evaluation } = data;
  const scoreEntries = Object.entries(evaluation.scores) as [keyof typeof EVALUATION_SCORE_CATEGORY_LABELS, number][];

  return (
    <div className="mt-2 space-y-4 rounded-md border border-ink-200 p-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="text-2xl font-semibold text-ink-900">{Math.round(evaluation.overall_score)}</span>
        <span className="text-xs text-ink-500">/ 100 overall &middot; {evaluation.llm_model}</span>
      </div>

      <div className="space-y-1.5">
        {scoreEntries.map(([key, value]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-xs text-ink-600">{EVALUATION_SCORE_CATEGORY_LABELS[key] ?? key}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
              <div className="h-full rounded-full bg-gold-500" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
            </div>
            <span className="w-8 shrink-0 text-right text-xs text-ink-500">{Math.round(value)}</span>
          </div>
        ))}
      </div>

      {evaluation.what_went_well.length > 0 && (
        <FindingList title="What went well" items={evaluation.what_went_well} />
      )}
      {evaluation.what_went_poorly.length > 0 && (
        <FindingList title="What went poorly" items={evaluation.what_went_poorly} />
      )}
      {evaluation.missed_opportunities.length > 0 && (
        <FindingList title="Missed opportunities" items={evaluation.missed_opportunities} />
      )}
      {evaluation.incorrect_statements.length > 0 && (
        <FindingList title="Incorrect statements" items={evaluation.incorrect_statements} />
      )}
      {evaluation.customer_objections.length > 0 && (
        <FindingList title="Customer objections" items={evaluation.customer_objections} />
      )}
      {evaluation.recommended_improvement && (
        <p><span className="font-semibold text-ink-700">Recommended improvement: </span>{evaluation.recommended_improvement}</p>
      )}
    </div>
  );
}

function FindingList({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div>
      <p className="font-semibold text-ink-700">{title}</p>
      <ul className="ml-4 list-disc text-ink-700">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-400">{label}</p>
      <p className={`text-ink-900 ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

function RecordingPlayer({ callId, recording }: { callId: string; recording: any }): JSX.Element {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  if (!recording || recording.status === 'failed') {
    return <p className="mt-2 rounded-md border border-ink-200 bg-ink-50 p-3 text-sm text-ink-500">{recording?.failure_reason ?? 'No recording is available for this call.'}</p>;
  }
  if (recording.status !== 'ready') {
    return <p className="mt-2 text-sm text-ink-500">Recording is still being processed...</p>;
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const url = await fetchRecordingObjectUrl(callId);
      setAudioUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the recording.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-ink-200 p-3">
      {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
      {!audioUrl ? (
        <Button variant="secondary" disabled={loading} onClick={load}>
          <Play className="h-4 w-4" /> {loading ? 'Loading...' : 'Load recording'}
        </Button>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-full bg-ink-900 p-2 text-white"
            onClick={() => {
              if (!audioEl) return;
              if (playing) audioEl.pause();
              else audioEl.play();
            }}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <audio
            ref={(el) => setAudioEl(el)}
            src={audioUrl}
            controls
            className="w-full"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          <a href={audioUrl} download={`call-${callId}.${recording.format ?? 'mp3'}`} className="text-ink-500 hover:text-ink-800">
            <Download className="h-4 w-4" />
          </a>
        </div>
      )}
      <p className="mt-2 text-xs text-ink-400">
        Format: {recording.format ?? 'unknown'} - {recording.duration_seconds ?? '?'}s - {recording.size_bytes ? `${Math.round(recording.size_bytes / 1024)} KB` : ''}
      </p>
    </div>
  );
}
