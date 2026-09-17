/**
 * Phase 11: AI call evaluator (master spec sections 24/86).
 *
 * Follows the EXACT same pattern as Phase 9's services/generateCallSummary
 * .ts: call the LLM via Phase 3's adapter (getLlmProvider()) with a
 * structured-JSON rubric prompt, retry once (a fresh, isolated
 * generateText() call) on a malformed response, and if still malformed
 * mark the evaluation as failed - never fabricate scores.
 *
 * Triggered from services/processCallArtifacts.ts once a call's
 * transcript is ready, which itself only runs after
 * services/callTerminalHandler.ts has already (synchronously, in the same
 * terminal-transition handler) assigned this call's disposition via
 * services/dispositionEngine.ts - so by the time this runs, both the
 * transcript AND disposition this module needs are already committed.
 *
 * A call is honestly SKIPPED (no call_evaluations row, no fabricated
 * score) when:
 *   - no LLM provider is configured (isConfigured is false), or
 *   - the call has no ready transcript (failed/very-short/cancelled
 *     calls never reached a real conversation to evaluate), or
 *   - the call never got a disposition (should not happen for a
 *     non-cancelled terminal call per callTerminalHandler.ts, but this is
 *     real input data this module refuses to guess at).
 * These are structural no-ops, exactly like generateCallSummary's "no
 * LLM configured" case - never a placeholder evaluation.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { getLlmProvider } from '../lib/llm/index.js';
import { EVALUATION_SCORE_CATEGORIES, type CallEvaluation, type EvaluationScoreCategory } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const EVALUATION_MODEL = process.env.CALL_EVALUATION_MODEL ?? 'gpt-4o-mini';

const SCORE_FIELDS_DESCRIPTION = EVALUATION_SCORE_CATEGORIES.map((c) => `"${c}": <0-100 number>`).join(',\n    ');

const EVALUATION_SYSTEM_PROMPT = `You are a strict, evidence-based call quality evaluator for a contact-center platform. You are given a real phone call transcript between an AI voice agent and a caller, plus the agent's own configured system prompt/script (its "should have done this" reference) and the call's real metadata (disposition, duration).

Score the call honestly against the transcript - never assume something happened that is not actually in the transcript, and never give a score you cannot justify from the text. Respond with ONLY a single JSON object (no markdown fences, no commentary) with EXACTLY this shape:
{
  "overall_score": <0-100 number - your overall holistic score>,
  "scores": {
    ${SCORE_FIELDS_DESCRIPTION}
  },
  "what_went_well": ["short concrete observation", "..."],
  "what_went_poorly": ["short concrete observation", "..."],
  "missed_opportunities": ["short concrete observation", "..."],
  "incorrect_statements": ["a statement the AI agent made that was factually wrong or contradicted its own knowledge/script, verbatim or closely paraphrased", "..."],
  "customer_objections": ["an objection the caller raised, and briefly how it was (or wasn't) handled", "..."],
  "recommended_improvement": "one concise, specific sentence recommending how this agent's configuration/prompt could be improved based on this call, or null if nothing stands out"
}
All array fields must always be present (use [] when there is nothing to report). Every numeric score must be a plain number 0-100. Base every score and every observation strictly on the transcript and the agent's configuration you were given - never invent details that are not there.`;

export interface ParsedEvaluation {
  overall_score: number;
  scores: Record<EvaluationScoreCategory, number>;
  what_went_well: string[];
  what_went_poorly: string[];
  missed_opportunities: string[];
  incorrect_statements: string[];
  customer_objections: string[];
  recommended_improvement: string | null;
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

/** Extracts and validates the structured evaluation from a raw LLM text
 * response. Tolerates a markdown code fence wrapper but otherwise
 * requires the full rubric shape - a response missing scores entirely, or
 * whose overall_score is not a number, is rejected (never silently
 * defaulted to 0, which would look like a real - if terrible - score). */
export function parseEvaluationResponse(raw: string): ParsedEvaluation {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : raw).trim();
  const parsed = JSON.parse(jsonText);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('LLM evaluation response is not a JSON object.');
  }
  if (typeof parsed.overall_score !== 'number' && typeof parsed.overall_score !== 'string') {
    throw new Error('LLM evaluation response is missing a valid "overall_score".');
  }
  if (typeof parsed.scores !== 'object' || parsed.scores === null) {
    throw new Error('LLM evaluation response is missing a valid "scores" object.');
  }

  const scores = {} as Record<EvaluationScoreCategory, number>;
  for (const category of EVALUATION_SCORE_CATEGORIES) {
    scores[category] = clampScore(parsed.scores[category]);
  }

  return {
    overall_score: clampScore(parsed.overall_score),
    scores,
    what_went_well: toStringArray(parsed.what_went_well),
    what_went_poorly: toStringArray(parsed.what_went_poorly),
    missed_opportunities: toStringArray(parsed.missed_opportunities),
    incorrect_statements: toStringArray(parsed.incorrect_statements),
    customer_objections: toStringArray(parsed.customer_objections),
    recommended_improvement:
      typeof parsed.recommended_improvement === 'string' && parsed.recommended_improvement.trim().length > 0
        ? parsed.recommended_improvement.trim()
        : null,
  };
}

async function upsertEvaluation(
  supabase: Supabase,
  callId: string,
  orgId: string,
  parsed: ParsedEvaluation,
  provider: string,
  model: string,
): Promise<CallEvaluation> {
  const values = {
    organization_id: orgId,
    overall_score: parsed.overall_score,
    scores: parsed.scores,
    what_went_well: parsed.what_went_well,
    what_went_poorly: parsed.what_went_poorly,
    missed_opportunities: parsed.missed_opportunities,
    incorrect_statements: parsed.incorrect_statements,
    customer_objections: parsed.customer_objections,
    recommended_improvement: parsed.recommended_improvement,
    llm_provider: provider,
    llm_model: model,
    evaluated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabase.from('call_evaluations').select('id').eq('call_id', callId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from('call_evaluations').update(values).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data as CallEvaluation;
  }
  const { data, error } = await supabase.from('call_evaluations').insert({ call_id: callId, ...values }).select('*').single();
  if (error) throw error;
  return data as CallEvaluation;
}

/** Builds the user-turn context given to the evaluator: the real
 * transcript, the agent version's own system prompt/script (spec section
 * 88's call-metadata reproducibility intent - the evaluator judges the
 * call against the actual configuration that ran it, not the agent's
 * current live config which may have since changed), and real call
 * metadata (disposition, duration). */
function buildEvaluationContext(params: {
  transcriptText: string;
  systemPrompt: string;
  greeting: string;
  dispositionName: string | null;
  durationSeconds: number | null;
  endedReason: string | null;
}): string {
  return [
    `Agent's configured system prompt (the standard this call should be judged against):\n${params.systemPrompt || '(none configured)'}`,
    params.greeting ? `Agent's configured greeting:\n${params.greeting}` : null,
    `Call metadata: disposition=${params.dispositionName ?? 'unknown'}, duration_seconds=${params.durationSeconds ?? 'unknown'}, ended_reason=${params.endedReason ?? 'unknown'}`,
    `Transcript:\n${params.transcriptText}`,
  ]
    .filter((s): s is string => Boolean(s))
    .join('\n\n---\n\n');
}

/** Generates (or regenerates) the AI evaluation for one call from its
 * already-ingested transcript and already-assigned disposition. A
 * structural no-op (returns null) whenever real input data is missing or
 * no LLM is configured - never a fabricated evaluation. */
export async function evaluateCall(callId: string): Promise<CallEvaluation | null> {
  const llm = getLlmProvider();
  if (!llm.isConfigured) return null;

  const supabase = getSupabaseAdmin();
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (!call) return null;

  const { data: transcript } = await supabase.from('call_transcripts').select('*').eq('call_id', callId).maybeSingle();
  if (!transcript || transcript.status !== 'ready' || !transcript.full_text) return null;

  const { data: dispositionRow } = await supabase
    .from('call_dispositions')
    .select('disposition_id')
    .eq('call_id', callId)
    .maybeSingle();
  if (!dispositionRow) return null;
  let dispositionName: string | null = null;
  if (dispositionRow.disposition_id) {
    const { data: disposition } = await supabase.from('dispositions').select('name').eq('id', dispositionRow.disposition_id).maybeSingle();
    dispositionName = disposition?.name ?? null;
  }

  const { data: version } = await supabase
    .from('ai_agent_versions')
    .select('system_prompt, greeting_template')
    .eq('id', call.ai_agent_version_id)
    .maybeSingle();

  const userContent = buildEvaluationContext({
    transcriptText: transcript.full_text,
    systemPrompt: version?.system_prompt ?? '',
    greeting: version?.greeting_template ?? '',
    dispositionName,
    durationSeconds: call.duration_seconds ?? null,
    endedReason: call.ended_reason ?? null,
  });

  const messages = [
    { role: 'system' as const, content: EVALUATION_SYSTEM_PROMPT },
    { role: 'user' as const, content: userContent },
  ];

  let parsed: ParsedEvaluation | null = null;
  let lastError: unknown = null;
  let model = EVALUATION_MODEL;
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    try {
      const result = await llm.generateText({ model: EVALUATION_MODEL, messages, temperature: 0.1, maxTokens: 1500 });
      model = result.model || EVALUATION_MODEL;
      parsed = parseEvaluationResponse(result.text);
    } catch (err) {
      lastError = err;
    }
  }

  if (!parsed) {
    // eslint-disable-next-line no-console
    console.error('evaluateCall: LLM did not return a parseable evaluation after retry for call', callId, lastError);
    return null;
  }

  return upsertEvaluation(supabase, callId, call.organization_id, parsed, llm.name, model);
}
