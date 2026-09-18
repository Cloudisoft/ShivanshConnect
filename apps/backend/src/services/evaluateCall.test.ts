import { describe, expect, it, vi } from 'vitest';
import { EVALUATION_SCORE_CATEGORIES } from '@shivanshconnect/shared';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import type { GenerateTextResult, LlmProviderAdapter } from '../lib/llm/types.js';

const fake = createFakeSupabase();
vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

const { parseEvaluationResponse, evaluateCall } = await import('./evaluateCall.js');
const llm = await import('../lib/llm/index.js');

function fullScores(value = 80): Record<string, number> {
  return Object.fromEntries(EVALUATION_SCORE_CATEGORIES.map((c) => [c, value]));
}

describe('evaluateCall.parseEvaluationResponse - LLM JSON parsing with malformed-response handling', () => {
  it('parses a well-formed JSON object with the full rubric', () => {
    const raw = JSON.stringify({
      overall_score: 82,
      scores: fullScores(75),
      what_went_well: ['Greeted warmly'],
      what_went_poorly: ['Talked over the caller once'],
      missed_opportunities: ['Never asked about budget'],
      incorrect_statements: [],
      customer_objections: ['Said the price was too high'],
      recommended_improvement: 'Ask a budget-qualifying question earlier in the call.',
    });

    const parsed = parseEvaluationResponse(raw);
    expect(parsed.overall_score).toBe(82);
    expect(parsed.scores.opening).toBe(75);
    expect(parsed.scores.compliance).toBe(75);
    expect(parsed.what_went_well).toEqual(['Greeted warmly']);
    expect(parsed.missed_opportunities).toEqual(['Never asked about budget']);
    expect(parsed.recommended_improvement).toBe('Ask a budget-qualifying question earlier in the call.');
  });

  it('unwraps a markdown code fence around the JSON', () => {
    const raw = `\`\`\`json\n${JSON.stringify({ overall_score: 50, scores: fullScores(50) })}\n\`\`\``;
    const parsed = parseEvaluationResponse(raw);
    expect(parsed.overall_score).toBe(50);
    expect(parsed.scores.tone).toBe(50);
  });

  it('clamps out-of-range and defaults missing sub-scores to a real number rather than throwing', () => {
    const parsed = parseEvaluationResponse(JSON.stringify({ overall_score: 200, scores: { opening: -10 } }));
    expect(parsed.overall_score).toBe(100);
    expect(parsed.scores.opening).toBe(0);
    expect(parsed.scores.closing).toBe(0); // missing entirely -> defaults to 0, never fabricated as "average"
    expect(parsed.what_went_well).toEqual([]);
    expect(parsed.recommended_improvement).toBeNull();
  });

  it('throws on genuinely malformed JSON - never silently coerces garbage into a fake evaluation', () => {
    expect(() => parseEvaluationResponse('not json at all')).toThrow();
  });

  it('throws when "overall_score" or "scores" is missing entirely', () => {
    expect(() => parseEvaluationResponse(JSON.stringify({ scores: fullScores() }))).toThrow();
    expect(() => parseEvaluationResponse(JSON.stringify({ overall_score: 80 }))).toThrow();
  });
});

class SequenceLlmProvider implements LlmProviderAdapter {
  readonly name = 'fake';
  readonly isConfigured = true;
  private calls = 0;
  constructor(private readonly responses: string[]) {}
  get callCount(): number {
    return this.calls;
  }
  async generateText(): Promise<GenerateTextResult> {
    const text = this.responses[Math.min(this.calls, this.responses.length - 1)];
    this.calls += 1;
    return { text, model: 'fake-model' };
  }
  async embedText(): Promise<never> {
    throw new Error('not used');
  }
}

let evalOrgCounter = 0;

function seedEvaluableCall() {
  evalOrgCounter += 1;
  const org = { id: `org-eval-${evalOrgCounter}`, status: 'active', timezone: 'UTC' };
  fake.tables.organizations.push(org);
  const agent = { id: `agent-eval-${evalOrgCounter}`, organization_id: org.id, name: 'Eval Agent', role: 'sales_agent', status: 'active', current_version_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  fake.tables.ai_agents.push(agent);
  const version = { id: `version-eval-${evalOrgCounter}`, agent_id: agent.id, organization_id: org.id, version_number: 1, system_prompt: 'You are a helpful sales agent.', greeting_template: 'Hi!', status: 'published', created_at: new Date().toISOString() };
  fake.tables.ai_agent_versions.push(version);
  const call = { id: `call-eval-${Math.random()}`, organization_id: org.id, ai_agent_id: agent.id, ai_agent_version_id: version.id, engine: 'vapi', direction: 'outbound', customer_number: '+15550001111', status: 'completed', duration_seconds: 120, ended_reason: 'customer-ended-call', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  fake.tables.calls.push(call);
  fake.tables.call_transcripts.push({ id: `transcript-${call.id}`, call_id: call.id, organization_id: org.id, full_text: 'AI: Hi there.\nUser: Hello.', status: 'ready', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const disposition = fake.tables.dispositions.find((d) => d.code === 'CALL_CONNECTED');
  fake.tables.call_dispositions.push({ id: `disp-${call.id}`, call_id: call.id, organization_id: org.id, disposition_id: disposition?.id ?? null, disposition_source: 'engine', assigned_at: new Date().toISOString() });
  return call;
}

describe('evaluateCall - retry-once-on-malformed-JSON, honest failure, and honest skips', () => {
  it('retries once and succeeds when the first response is malformed but the retry is well-formed', async () => {
    const call = seedEvaluableCall();
    const good = JSON.stringify({ overall_score: 88, scores: fullScores(88), what_went_well: ['Good rapport'] });
    const provider = new SequenceLlmProvider(['not json', good]);
    llm.__setLlmProviderForTests(provider);

    const result = await evaluateCall(call.id);
    expect(provider.callCount).toBe(2);
    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(88);
    expect(fake.tables.call_evaluations.find((e) => e.call_id === call.id)).toBeTruthy();

    llm.__setLlmProviderForTests(null);
  });

  it('fails cleanly (no row written) when both attempts are malformed - never a fabricated evaluation', async () => {
    const call = seedEvaluableCall();
    const provider = new SequenceLlmProvider(['not json', 'still not json']);
    llm.__setLlmProviderForTests(provider);

    const result = await evaluateCall(call.id);
    expect(provider.callCount).toBe(2);
    expect(result).toBeNull();
    expect(fake.tables.call_evaluations.find((e) => e.call_id === call.id)).toBeUndefined();

    llm.__setLlmProviderForTests(null);
  });

  it('honestly skips (returns null, no row) when no LLM provider is configured', async () => {
    const call = seedEvaluableCall();
    llm.__setLlmProviderForTests({ name: 'none', isConfigured: false, generateText: async () => { throw new Error('unused'); }, embedText: async () => { throw new Error('unused'); } });

    const result = await evaluateCall(call.id);
    expect(result).toBeNull();
    expect(fake.tables.call_evaluations.find((e) => e.call_id === call.id)).toBeUndefined();

    llm.__setLlmProviderForTests(null);
  });

  it('honestly skips when the call has no ready transcript', async () => {
    const call = seedEvaluableCall();
    fake.tables.call_transcripts.find((t) => t.call_id === call.id)!.status = 'pending';
    const provider = new SequenceLlmProvider([JSON.stringify({ overall_score: 50, scores: fullScores(50) })]);
    llm.__setLlmProviderForTests(provider);

    const result = await evaluateCall(call.id);
    expect(result).toBeNull();
    expect(provider.callCount).toBe(0);

    llm.__setLlmProviderForTests(null);
  });
});
