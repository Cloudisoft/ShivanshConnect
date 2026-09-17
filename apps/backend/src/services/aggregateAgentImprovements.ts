/**
 * Phase 11: improvement mining (master spec sections 24/49/86).
 *
 * Runs immediately after each successful evaluation (called from
 * services/processCallArtifacts.ts right after services/evaluateCall.ts
 * resolves with a real evaluation), rather than as a separate periodic
 * batch job. This is the architecturally simpler choice for this
 * codebase: every other cross-call aggregation step here (dispositions,
 * campaign lead outcomes, live-monitor events) is triggered off a single
 * call's own terminal event, not a cron/worker process - there is no
 * scheduler infrastructure in this build to add a periodic pass to, and
 * running per-evaluation keeps the improvement queue current within one
 * call's fire-and-forget window instead of up to a batch interval stale.
 * The frequency-increment logic below is idempotent per call (a given
 * call is scanned exactly once - on its own evaluation), so this never
 * double-counts even though it runs eagerly.
 *
 * Mining strategy (deliberately simple, per the task brief's "don't
 * over-engineer an ML clustering system" instruction):
 *   - candidate issues are pulled straight from the evaluation's own
 *     missed_opportunities / incorrect_statements / what_went_poorly
 *     arrays (each item is real LLM-extracted, evidence-backed text -
 *     never synthesized here);
 *   - a candidate is matched against this agent's existing
 *     detected/under_review improvements by (a) same category and (b) a
 *     plain Jaccard word-overlap similarity over normalized text -
 *     matching increments frequency and appends real evidence;
 *   - a genuinely new issue gets ONE extra LLM call to draft a
 *     suggested_change + confidence, clearly separate from the evaluator
 *     call above and clearly a SUGGESTION only - this module never
 *     touches ai_agent_versions or the agent's live prompt. If that LLM
 *     call fails/is malformed after one retry, the candidate is dropped
 *     (never a fabricated suggestion), matching every other LLM-backed
 *     service in this codebase.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { getLlmProvider } from '../lib/llm/index.js';
import type { AgentImprovementEvidence, CallEvaluation } from '@shivanshconnect/shared';

const SUGGESTION_MODEL = process.env.AGENT_IMPROVEMENT_MODEL ?? 'gpt-4o-mini';
const MAX_ITEMS_PER_CATEGORY = 5;
const SIMILARITY_MATCH_THRESHOLD = 0.5;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'is', 'was', 'were', 'it', 'its',
  'that', 'this', 'did', 'not', 'be', 'as', 'at', 'by', 'but', 'so', 'their', 'they', 'agent', 'caller',
]);

/** Lowercases, strips punctuation and stopwords, and returns the
 * remaining word set - used only for a cheap similarity comparison, never
 * stored or shown to a human. */
export function normalizeForMatch(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Plain Jaccard similarity (|intersection| / |union|) over two word
 * sets - simple, deterministic, and cheap; deliberately not an ML/
 * embedding-based clustering approach, per the task brief. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type IssueCategory = 'missed_opportunity' | 'incorrect_statement' | 'went_poorly';

const CATEGORY_LABELS: Record<IssueCategory, string> = {
  missed_opportunity: 'Missed opportunity',
  incorrect_statement: 'Incorrect statement',
  went_poorly: 'Went poorly',
};

export interface IssueCandidate {
  category: IssueCategory;
  text: string;
}

export function extractCandidates(evaluation: Pick<CallEvaluation, 'missed_opportunities' | 'incorrect_statements' | 'what_went_poorly'>): IssueCandidate[] {
  const candidates: IssueCandidate[] = [];
  for (const text of (evaluation.missed_opportunities ?? []).slice(0, MAX_ITEMS_PER_CATEGORY)) {
    candidates.push({ category: 'missed_opportunity', text });
  }
  for (const text of (evaluation.incorrect_statements ?? []).slice(0, MAX_ITEMS_PER_CATEGORY)) {
    candidates.push({ category: 'incorrect_statement', text });
  }
  for (const text of (evaluation.what_went_poorly ?? []).slice(0, MAX_ITEMS_PER_CATEGORY)) {
    candidates.push({ category: 'went_poorly', text });
  }
  return candidates;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function buildIssueLabel(candidate: IssueCandidate): string {
  return `${CATEGORY_LABELS[candidate.category]}: ${truncate(candidate.text, 140)}`;
}

interface SuggestionResult {
  suggested_change: string;
  confidence: number;
}

const SUGGESTION_SYSTEM_PROMPT = `You advise on improving an AI voice agent's configuration for a contact-center platform, based on a recurring issue observed across real calls. You are NOT rewriting the agent's prompt yourself - you are drafting a short, concrete SUGGESTION for a human reviewer to consider. Respond with ONLY a single JSON object (no markdown fences, no commentary):
{
  "suggested_change": "one or two concise sentences recommending a specific, concrete change to the agent's system prompt, script, or knowledge base that would address this issue",
  "confidence": <0-1 number - how confident you are this is a real, actionable pattern versus a one-off>
}`;

function parseSuggestionResponse(raw: string): SuggestionResult {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : raw).trim();
  const parsed = JSON.parse(jsonText);
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.suggested_change !== 'string' || parsed.suggested_change.trim().length === 0) {
    throw new Error('LLM suggestion response is missing a valid "suggested_change" string.');
  }
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : Number(parsed.confidence);
  return {
    suggested_change: parsed.suggested_change.trim(),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
  };
}

async function draftSuggestion(candidate: IssueCandidate, excerpts: string[]): Promise<SuggestionResult | null> {
  const llm = getLlmProvider();
  if (!llm.isConfigured) return null;

  const messages = [
    { role: 'system' as const, content: SUGGESTION_SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: `Category: ${CATEGORY_LABELS[candidate.category]}\nIssue: ${candidate.text}\n\nReal evidence excerpts from the call(s) where this occurred:\n${excerpts.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
    },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await llm.generateText({ model: SUGGESTION_MODEL, messages, temperature: 0.2, maxTokens: 300 });
      return parseSuggestionResponse(result.text);
    } catch {
      // retry once, then give up - handled by the caller returning null
    }
  }
  return null;
}

/** Mines the given evaluation's qualitative findings for recurring
 * issues on this agent and creates/increments ai_agent_improvements rows.
 * A structural no-op when there is nothing to mine or no LLM is
 * configured for the suggestion draft - never fabricates a suggestion. */
export async function aggregateAgentImprovements(callId: string, evaluation: CallEvaluation): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: call } = await supabase.from('calls').select('id, organization_id, ai_agent_id').eq('id', callId).maybeSingle();
  if (!call) return;

  const candidates = extractCandidates(evaluation);
  if (candidates.length === 0) return;

  const { data: existingRows } = await supabase
    .from('ai_agent_improvements')
    .select('*')
    .eq('agent_id', call.ai_agent_id)
    .in('status', ['detected', 'under_review']);
  const existing = existingRows ?? [];

  const alreadyIncrementedThisRun = new Set<string>();

  for (const candidate of candidates) {
    const candidateTokens = normalizeForMatch(candidate.text);
    let bestMatch: { row: Record<string, any>; score: number } | null = null;
    for (const row of existing) {
      const rowCategory = (row.evidence as AgentImprovementEvidence | undefined)?.category;
      if (rowCategory !== candidate.category) continue;
      if (alreadyIncrementedThisRun.has(row.id)) continue;
      const score = jaccardSimilarity(candidateTokens, normalizeForMatch(String(row.issue ?? '')));
      if (score >= SIMILARITY_MATCH_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { row, score };
      }
    }

    const occurrence = {
      call_id: callId,
      evaluation_id: evaluation.id,
      category: candidate.category,
      excerpt: truncate(candidate.text, 300),
      detected_at: new Date().toISOString(),
    };

    if (bestMatch) {
      const row = bestMatch.row;
      const evidence: AgentImprovementEvidence = {
        category: candidate.category,
        occurrences: [...(((row.evidence as AgentImprovementEvidence | undefined)?.occurrences) ?? []), occurrence],
      };
      const { error } = await supabase
        .from('ai_agent_improvements')
        .update({
          frequency: (row.frequency ?? 1) + 1,
          evidence,
          source_call_id: callId,
          source_evaluation_id: evaluation.id,
        })
        .eq('id', row.id);
      if (!error) {
        row.frequency = (row.frequency ?? 1) + 1;
        row.evidence = evidence;
        alreadyIncrementedThisRun.add(row.id);
      }
      continue;
    }

    // A genuinely new issue - draft a suggestion. If the LLM isn't
    // configured or fails twice, skip this candidate entirely rather
    // than insert a row with a fabricated/placeholder suggested_change.
    const suggestion = await draftSuggestion(candidate, [occurrence.excerpt]);
    if (!suggestion) continue;

    const evidence: AgentImprovementEvidence = { category: candidate.category, occurrences: [occurrence] };
    const { data: inserted, error } = await supabase
      .from('ai_agent_improvements')
      .insert({
        organization_id: call.organization_id,
        agent_id: call.ai_agent_id,
        issue: buildIssueLabel(candidate),
        evidence,
        suggested_change: suggestion.suggested_change,
        confidence: suggestion.confidence,
        frequency: 1,
        status: 'detected',
        source_call_id: callId,
        source_evaluation_id: evaluation.id,
      })
      .select('*')
      .single();
    if (!error && inserted) existing.push(inserted);
  }
}
