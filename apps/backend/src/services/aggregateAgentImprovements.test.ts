import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import type { GenerateTextResult, LlmProviderAdapter } from '../lib/llm/types.js';

const fake = createFakeSupabase();
vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

const { extractCandidates, jaccardSimilarity, normalizeForMatch, aggregateAgentImprovements } = await import(
  './aggregateAgentImprovements.js'
);
const llm = await import('../lib/llm/index.js');

describe('normalizeForMatch / jaccardSimilarity - the plain text-similarity matcher', () => {
  it('scores near-identical rephrasings well above the match threshold', () => {
    const a = normalizeForMatch('Never asked the caller about their budget.');
    const b = normalizeForMatch('never asked about the caller budget');
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it('scores genuinely different issues low', () => {
    const a = normalizeForMatch('Never asked about the budget');
    const b = normalizeForMatch('Quoted an incorrect refund policy to the caller');
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.3);
  });
});

describe('extractCandidates', () => {
  it('pulls candidates from all three source arrays, capped per category', () => {
    const candidates = extractCandidates({
      missed_opportunities: ['a', 'b'],
      incorrect_statements: ['c'],
      what_went_poorly: ['d', 'e', 'f'],
    });
    expect(candidates).toHaveLength(6);
    expect(candidates.filter((c) => c.category === 'missed_opportunity')).toHaveLength(2);
    expect(candidates.filter((c) => c.category === 'incorrect_statement')).toHaveLength(1);
    expect(candidates.filter((c) => c.category === 'went_poorly')).toHaveLength(3);
  });

  it('returns no candidates when the evaluation has nothing to mine', () => {
    expect(extractCandidates({ missed_opportunities: [], incorrect_statements: [], what_went_poorly: [] })).toEqual([]);
  });
});

class FixedSuggestionLlm implements LlmProviderAdapter {
  readonly name = 'fake';
  readonly isConfigured = true;
  calls = 0;
  async generateText(): Promise<GenerateTextResult> {
    this.calls += 1;
    return { text: JSON.stringify({ suggested_change: 'Add a budget-qualifying question to the script.', confidence: 0.8 }), model: 'fake-model' };
  }
  async embedText(): Promise<never> {
    throw new Error('not used');
  }
}

let counter = 0;
function makeAgentAndOrg() {
  counter += 1;
  const org = { id: `org-agg-${counter}`, status: 'active', timezone: 'UTC' };
  fake.tables.organizations.push(org);
  const agent = { id: `agent-agg-${counter}`, organization_id: org.id, name: 'Agg Agent', role: 'sales_agent', status: 'active', current_version_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  fake.tables.ai_agents.push(agent);
  return { org, agent };
}

function makeCall(org: { id: string }, agent: { id: string }) {
  const call = { id: `call-agg-${counter}-${Math.random()}`, organization_id: org.id, ai_agent_id: agent.id, ai_agent_version_id: 'v', engine: 'vapi', direction: 'outbound', customer_number: '+15550002222', status: 'completed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  fake.tables.calls.push(call);
  return call;
}

function makeEvaluation(call: { id: string; organization_id: string }, overrides: Partial<Record<string, unknown>> = {}) {
  const evaluation = {
    id: `eval-${call.id}`,
    call_id: call.id,
    organization_id: call.organization_id,
    overall_score: 60,
    scores: {},
    what_went_well: [],
    what_went_poorly: [],
    missed_opportunities: ['Never asked about the customer\'s budget'],
    incorrect_statements: [],
    customer_objections: [],
    recommended_improvement: null,
    llm_provider: 'fake',
    llm_model: 'fake-model',
    evaluated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
  fake.tables.call_evaluations.push(evaluation as any);
  return evaluation as any;
}

describe('aggregateAgentImprovements - create-then-increment dedup', () => {
  it('creates a new detected improvement for a genuinely new issue', async () => {
    llm.__setLlmProviderForTests(new FixedSuggestionLlm());
    const { org, agent } = makeAgentAndOrg();
    const call = makeCall(org, agent);
    const evaluation = makeEvaluation(call);

    await aggregateAgentImprovements(call.id, evaluation);

    const rows = fake.tables.ai_agent_improvements.filter((r) => r.agent_id === agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('detected');
    expect(rows[0].frequency).toBe(1);
    expect(rows[0].suggested_change).toBe('Add a budget-qualifying question to the script.');
    expect(rows[0].source_call_id).toBe(call.id);
    expect(rows[0].evidence.occurrences).toHaveLength(1);

    llm.__setLlmProviderForTests(null);
  });

  it('increments frequency (never duplicates) when the same issue recurs on a second call for the same agent', async () => {
    const llmProvider = new FixedSuggestionLlm();
    llm.__setLlmProviderForTests(llmProvider);
    const { org, agent } = makeAgentAndOrg();

    const call1 = makeCall(org, agent);
    await aggregateAgentImprovements(call1.id, makeEvaluation(call1));

    const call2 = makeCall(org, agent);
    await aggregateAgentImprovements(call2.id, makeEvaluation(call2, { missed_opportunities: ["Never asked about the caller's budget"] }));

    const rows = fake.tables.ai_agent_improvements.filter((r) => r.agent_id === agent.id);
    expect(rows).toHaveLength(1); // never duplicated
    expect(rows[0].frequency).toBe(2);
    expect(rows[0].evidence.occurrences).toHaveLength(2);
    expect(rows[0].source_call_id).toBe(call2.id);
    // The suggestion LLM is only called once - for the FIRST, genuinely new
    // occurrence. A recurrence never re-generates a suggestion.
    expect(llmProvider.calls).toBe(1);

    llm.__setLlmProviderForTests(null);
  });

  it('creates a separate row for a genuinely different issue on the same agent', async () => {
    llm.__setLlmProviderForTests(new FixedSuggestionLlm());
    const { org, agent } = makeAgentAndOrg();

    const call1 = makeCall(org, agent);
    await aggregateAgentImprovements(call1.id, makeEvaluation(call1));

    const call2 = makeCall(org, agent);
    await aggregateAgentImprovements(
      call2.id,
      makeEvaluation(call2, { missed_opportunities: [], incorrect_statements: ['Told the caller refunds take 90 days when policy is 30 days'] }),
    );

    const rows = fake.tables.ai_agent_improvements.filter((r) => r.agent_id === agent.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.frequency === 1)).toBe(true);

    llm.__setLlmProviderForTests(null);
  });

  it('never fabricates a suggestion: drops a genuinely new candidate when no LLM is configured', async () => {
    llm.__setLlmProviderForTests({ name: 'none', isConfigured: false, generateText: async () => { throw new Error('unused'); }, embedText: async () => { throw new Error('unused'); } });
    const { org, agent } = makeAgentAndOrg();
    const call = makeCall(org, agent);

    await aggregateAgentImprovements(call.id, makeEvaluation(call));

    expect(fake.tables.ai_agent_improvements.filter((r) => r.agent_id === agent.id)).toHaveLength(0);

    llm.__setLlmProviderForTests(null);
  });
});
