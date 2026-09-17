/**
 * Phase 9: AI call summaries (master spec section 24-partial - summaries
 * only; the full call evaluator/scoring is Phase 11, out of scope here).
 *
 * Runs once a call's transcript is ready (see services/
 * processCallArtifacts.ts). If no LLM provider is configured
 * (lib/llm/index.ts's getLlmProvider().isConfigured is false, i.e. no
 * OPENAI_API_KEY), this is a structural no-op - `call_summaries` simply
 * never gets a row for that call, and the CDR detail UI shows an honest
 * "Summary requires an LLM provider to be configured" empty state. Never
 * fabricates a summary.
 *
 * The LLM is asked for a strict JSON object; a malformed response is
 * retried once (a fresh, isolated generateText() call, not a "fix your
 * JSON" follow-up prompt - the model gets a full clean attempt), and if
 * still malformed the summary is marked failed (no row written) with the
 * error logged - never a guessed/partial summary persisted.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { getLlmProvider } from '../lib/llm/index.js';
import type { CallSummary } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

const SUMMARY_MODEL = process.env.CALL_SUMMARY_MODEL ?? 'gpt-4o-mini';

const SUMMARY_SYSTEM_PROMPT = `You analyze a phone call transcript between an AI voice agent and a caller for a contact-center platform. Respond with ONLY a single JSON object (no markdown fences, no commentary) with exactly these keys:
{
  "summary": "a concise 2-4 sentence summary of what happened on the call",
  "key_points": ["short bullet point", "..."],
  "customer_intent": "one short sentence describing what the caller wanted, or null if unclear",
  "objections": ["objection the caller raised, if any", "..."],
  "questions": ["question the caller asked, if any", "..."],
  "next_action": "a short recommended next action, or null",
  "outcome": "a short label for how the call ended, or null"
}
key_points, objections and questions must always be arrays (use [] when there are none). Base everything strictly on the transcript - never invent details that are not in it.`;

export interface ParsedCallSummary {
  summary: string;
  key_points: string[];
  customer_intent: string | null;
  objections: string[] | null;
  questions: string[] | null;
  next_action: string | null;
  outcome: string | null;
}

/** Extracts and validates the structured summary from a raw LLM text
 * response. Tolerates the model wrapping the JSON in a markdown code
 * fence (common even when explicitly told not to) but otherwise requires
 * a genuinely well-formed object with the required shape - never
 * silently coerces garbage into a fake summary. */
export function parseSummaryResponse(raw: string): ParsedCallSummary {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : raw).trim();
  const parsed = JSON.parse(jsonText);

  if (typeof parsed !== 'object' || parsed === null || typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new Error('LLM summary response is missing a valid "summary" string field.');
  }

  const toStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const toNullableStringArray = (v: unknown): string[] | null => (Array.isArray(v) ? toStringArray(v) : null);
  const toNullableString = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

  return {
    summary: parsed.summary,
    key_points: toStringArray(parsed.key_points),
    customer_intent: toNullableString(parsed.customer_intent),
    objections: toNullableStringArray(parsed.objections),
    questions: toNullableStringArray(parsed.questions),
    next_action: toNullableString(parsed.next_action),
    outcome: toNullableString(parsed.outcome),
  };
}

async function upsertSummary(supabase: Supabase, callId: string, orgId: string, parsed: ParsedCallSummary, model: string): Promise<CallSummary> {
  const values = {
    organization_id: orgId,
    summary: parsed.summary,
    key_points: parsed.key_points,
    customer_intent: parsed.customer_intent,
    objections: parsed.objections,
    questions: parsed.questions,
    next_action: parsed.next_action,
    outcome: parsed.outcome,
    llm_provider: 'openai',
    llm_model: model,
    generated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabase.from('call_summaries').select('id').eq('call_id', callId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from('call_summaries').update(values).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data as CallSummary;
  }
  const { data, error } = await supabase.from('call_summaries').insert({ call_id: callId, ...values }).select('*').single();
  if (error) throw error;
  return data as CallSummary;
}

/** Generates (or regenerates) the AI summary for one call from its
 * already-ingested transcript. A structural no-op when no LLM is
 * configured or when the transcript itself isn't ready - never a
 * fabricated summary either way. */
export async function generateCallSummary(callId: string): Promise<CallSummary | null> {
  const llm = getLlmProvider();
  if (!llm.isConfigured) return null;

  const supabase = getSupabaseAdmin();
  const { data: transcript } = await supabase.from('call_transcripts').select('*').eq('call_id', callId).maybeSingle();
  if (!transcript || transcript.status !== 'ready' || !transcript.full_text) return null;

  const messages = [
    { role: 'system' as const, content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user' as const, content: `Transcript:\n\n${transcript.full_text}` },
  ];

  let parsed: ParsedCallSummary | null = null;
  let lastError: unknown = null;
  let model = SUMMARY_MODEL;
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    try {
      const result = await llm.generateText({ model: SUMMARY_MODEL, messages, temperature: 0.2, maxTokens: 700 });
      model = result.model || SUMMARY_MODEL;
      parsed = parseSummaryResponse(result.text);
    } catch (err) {
      lastError = err;
    }
  }

  if (!parsed) {
    // eslint-disable-next-line no-console
    console.error('generateCallSummary: LLM did not return a parseable summary after retry for call', callId, lastError);
    return null;
  }

  return upsertSummary(supabase, callId, transcript.organization_id, parsed, model);
}
