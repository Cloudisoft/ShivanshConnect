import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 11 integration tests: a call reaching a terminal state (with a
 * real transcript + disposition) drives the real evaluator pipeline
 * (services/evaluateCall.ts + services/aggregateAgentImprovements.ts) end
 * to end, and the human-in-the-loop improvement workflow
 * (routes/agentImprovements.ts) is exercised for real through
 * app.inject() - status transitions, apply-creates-a-draft-version, and
 * the snapshot-immutability regression guard (the previously PUBLISHED
 * version must never be mutated by applying an improvement).
 *
 * Same fakeSupabase harness/app.inject() pattern as every prior phase's
 * integration test. TEST-ONLY: the LLM calls (evaluation + suggestion,
 * on top of Phase 9's existing summary call) are all served by one
 * stubbed `global.fetch` against https://api.openai.com, distinguished by
 * inspecting each request's own system-prompt text - never a real
 * network call.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.WORKER_POOL_CAPACITY = '50';
process.env.OPENAI_API_KEY = 'sk-test-openai-key';
process.env.BACKEND_PUBLIC_URL = 'http://localhost:4000';

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

const FLAT_TRANSCRIPT = 'AI: Hi, this is Alex calling from Acme.\nUser: Hi, sure I have a minute.\nAI: Great, are you still interested in a quote?\nUser: Yes, please send it over.';
const RECURRING_ISSUE = "Never asked about the caller's budget";

const LLM_SUMMARY = {
  summary: 'Caller confirmed interest and asked for a quote to be sent.',
  key_points: ['Confirmed interest'],
  customer_intent: 'Get a quote',
  objections: [],
  questions: [],
  next_action: 'Send the quote by email',
  outcome: 'Positive',
};

function llmEvaluationResponse(overallScore: number) {
  const scores: Record<string, number> = {};
  for (const c of [
    'opening', 'introduction', 'listening', 'understanding', 'accuracy', 'knowledge_usage',
    'objection_handling', 'tone', 'empathy', 'professionalism', 'script_adherence', 'sop_adherence',
    'compliance', 'call_control', 'transfer_handling', 'closing', 'disposition_accuracy',
  ]) {
    scores[c] = overallScore;
  }
  return {
    overall_score: overallScore,
    scores,
    what_went_well: ['Friendly greeting'],
    what_went_poorly: [],
    missed_opportunities: [RECURRING_ISSUE],
    incorrect_statements: [],
    customer_objections: [],
    recommended_improvement: 'Ask a budget-qualifying question earlier.',
  };
}

const LLM_SUGGESTION = {
  suggested_change: 'Add a budget-qualifying question right after the greeting.',
  confidence: 0.82,
};

let vapiCallCounter = 0;
let vapiAssistantCounter = 0;
let vapiPhoneNumberCounter = 0;

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor() timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Phase 11: AI call evaluator + improvement queue', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;
  let processCampaign: typeof import('./services/campaignDispatcher.js').processCampaign;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === 'https://api.vapi.ai/assistant' && method === 'POST') {
        vapiAssistantCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p11_asst_${vapiAssistantCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
        vapiPhoneNumberCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p11_vapi_pn_${vapiPhoneNumberCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/call' && method === 'POST') {
        vapiCallCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p11_vapi_call_${vapiCallCounter}`, status: 'queued' }) } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/assistant?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/call/') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: url.split('/').pop(), status: 'ended', artifact: { recordingUrl: null, transcript: FLAT_TRANSCRIPT, transcriptUrl: null } }),
        } as unknown as Response;
      }
      if (url === 'https://api.openai.com/v1/chat/completions' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const systemContent = String(body.messages?.[0]?.content ?? '');
        let content: unknown = LLM_SUMMARY;
        if (systemContent.includes('strict, evidence-based call quality evaluator')) {
          content = llmEvaluationResponse(60);
        } else if (systemContent.includes("advise on improving an AI voice agent")) {
          content = LLM_SUGGESTION;
        }
        return { ok: true, status: 200, json: async () => ({ model: 'gpt-4o-mini', choices: [{ message: { content: JSON.stringify(content) } }] }) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
    processCampaign = (await import('./services/campaignDispatcher.js')).processCampaign;
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return res.json().data.session.access_token as string;
  }

  async function setUpOrgBasics(token: string) {
    const agentRes = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Eval Agent', role: 'sales_agent' } });
    const agent = agentRes.json().data;
    const versionRes = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions`, headers: { authorization: `Bearer ${token}` }, payload: { system_prompt: 'You are a helpful sales agent.', greeting_template: 'Hi there!' } });
    const agentVersion = versionRes.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions/${agentVersion.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'PATCH', url: `/api/v1/agents/${agent.id}`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'active' } });
    await app.inject({ method: 'POST', url: '/api/v1/vapi/credentials', headers: { authorization: `Bearer ${token}` }, payload: { api_key: 'sk-vapi-test' } });
    await app.inject({ method: 'POST', url: '/api/v1/vapi/test-connection', headers: { authorization: `Bearer ${token}` } });
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider_key: 'byon', phone_number: `+1484557${Math.floor(1000 + Math.random() * 8999)}`, capabilities: { voice_inbound: true, voice_outbound: true, sms: false }, sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' } },
    });
    const phoneNumber = importRes.json().data;
    return { agent, agentVersion, phoneNumber };
  }

  async function dialOnAgent(token: string, agentId: string, phoneNumberId: string) {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/campaigns', headers: { authorization: `Bearer ${token}` }, payload: { name: `P11 Campaign ${Date.now()}-${Math.random()}`, phone_number_id: phoneNumberId, concurrency_limit: 5, transfer_number_e164: '+14845550099' } });
    const campaign = createRes.json().data;
    const listRes = await app.inject({ method: 'POST', url: '/api/v1/lead-lists', headers: { authorization: `Bearer ${token}` }, payload: { name: `P11 List ${Date.now()}-${Math.random()}` } });
    const list = listRes.json().data;
    const numbers = [`+1202556${Math.floor(1000 + Math.random() * 8999)}`];
    await app.inject({ method: 'POST', url: '/api/v1/leads/bulk', headers: { authorization: `Bearer ${token}` }, payload: { lead_list_id: list.id, numbers } });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/leads`, headers: { authorization: `Bearer ${token}` }, payload: { lead_list_id: list.id } });
    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaign.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Hi {{first_name}}.', ai_agent_id: agentId, calling_rules: { calling_window_start: '00:00', calling_window_end: '23:59', calling_days: [1, 2, 3, 4, 5, 6, 7] } },
    });
    const version = versionRes.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/versions/${version.id}/publish`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });

    const result = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    expect(result.dispatched).toBe(1);
    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;
    const call = fake.tables.calls.find((c) => c.id === cl.last_call_id)!;

    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 90 } } });

    return { call };
  }

  it('evaluates a call with a real transcript+disposition and stores the full rubric', async () => {
    const token = await signup('Eval Org', `eval-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { call } = await dialOnAgent(token, agent.id, phoneNumber.id);

    await waitFor(() => fake.tables.call_evaluations.some((e) => e.call_id === call.id));

    const getRes = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}/evaluation`, headers: { authorization: `Bearer ${token}` } });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json().data;
    expect(body.state).toBe('evaluated');
    expect(body.evaluation.overall_score).toBe(60);
    expect(Object.keys(body.evaluation.scores)).toHaveLength(17);
    expect(body.evaluation.missed_opportunities).toEqual([RECURRING_ISSUE]);
  });

  it('a call with no ready transcript is honestly skipped, never fabricated', async () => {
    const token = await signup('Skip Org', `skip-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { call } = await dialOnAgent(token, agent.id, phoneNumber.id);
    await waitFor(() => fake.tables.call_evaluations.some((e) => e.call_id === call.id));

    // A call that never reached the engine at all (no provider call id) -
    // processCallArtifacts marks its transcript failed, so evaluateCall
    // must never run for it.
    const orphanCallId = randomUUID();
    fake.tables.calls.push({ id: orphanCallId, organization_id: fake.tables.calls.find((c) => c.id === call.id)!.organization_id, ai_agent_id: agent.id, ai_agent_version_id: agent.current_version_id, engine: 'vapi', direction: 'outbound', customer_number: '+15550000000', status: 'failed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const res = await app.inject({ method: 'GET', url: `/api/v1/calls/${orphanCallId}/evaluation`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.state).toBe('skipped');
  });

  it('a second call surfacing the same recurring issue increments frequency instead of duplicating, and the full approve -> apply -> draft workflow never touches the published version', async () => {
    const token = await signup('Improve Org', `improve-${Date.now()}@test.com`);
    const { agent, agentVersion, phoneNumber } = await setUpOrgBasics(token);

    const { call: call1 } = await dialOnAgent(token, agent.id, phoneNumber.id);
    await waitFor(() => fake.tables.call_evaluations.some((e) => e.call_id === call1.id));
    await waitFor(() => fake.tables.ai_agent_improvements.some((i) => i.agent_id === agent.id));

    const afterFirst = fake.tables.ai_agent_improvements.filter((i) => i.agent_id === agent.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].frequency).toBe(1);
    const improvementId = afterFirst[0].id;

    const { call: call2 } = await dialOnAgent(token, agent.id, phoneNumber.id);
    await waitFor(() => fake.tables.call_evaluations.some((e) => e.call_id === call2.id));
    await waitFor(() => (fake.tables.ai_agent_improvements.find((i) => i.id === improvementId)?.frequency ?? 0) >= 2);

    const afterSecond = fake.tables.ai_agent_improvements.filter((i) => i.agent_id === agent.id);
    expect(afterSecond).toHaveLength(1); // never duplicated
    expect(afterSecond[0].frequency).toBe(2);

    // status-transition validation: can't apply a non-approved improvement,
    // can't skip states.
    const applyTooEarly = await app.inject({ method: 'POST', url: `/api/v1/agent-improvements/${improvementId}/apply`, headers: { authorization: `Bearer ${token}` } });
    expect(applyTooEarly.statusCode).toBe(422);

    const skipToApproved = await app.inject({ method: 'PATCH', url: `/api/v1/agent-improvements/${improvementId}`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'approved' } });
    expect(skipToApproved.statusCode).toBe(422); // must go detected -> under_review first

    const toReview = await app.inject({ method: 'PATCH', url: `/api/v1/agent-improvements/${improvementId}`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'under_review' } });
    expect(toReview.statusCode).toBe(200);
    expect(toReview.json().data.status).toBe('under_review');

    const toApproved = await app.inject({ method: 'PATCH', url: `/api/v1/agent-improvements/${improvementId}`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'approved' } });
    expect(toApproved.statusCode).toBe(200);

    const originalPublishedPrompt = fake.tables.ai_agent_versions.find((v) => v.id === agentVersion.id)!.system_prompt;

    const applyRes = await app.inject({ method: 'POST', url: `/api/v1/agent-improvements/${improvementId}/apply`, headers: { authorization: `Bearer ${token}` } });
    expect(applyRes.statusCode).toBe(200);
    const applyBody = applyRes.json().data;
    expect(applyBody.improvement.status).toBe('applied');
    expect(applyBody.draft_version.status).toBe('draft'); // never auto-published
    expect(applyBody.draft_version.system_prompt).toContain(LLM_SUGGESTION.suggested_change);

    // Regression guard (Phase 7's snapshot-immutability guarantee, proven
    // again here): the ORIGINAL published version is byte-for-byte
    // unchanged after applying the improvement.
    const publishedAfterApply = fake.tables.ai_agent_versions.find((v) => v.id === agentVersion.id)!;
    expect(publishedAfterApply.system_prompt).toBe(originalPublishedPrompt);
    expect(publishedAfterApply.status).toBe('published');

    // The new draft is a genuinely separate row, still unpublished.
    const draftRow = fake.tables.ai_agent_versions.find((v) => v.id === applyBody.draft_version.id)!;
    expect(draftRow.status).toBe('draft');
    expect(draftRow.id).not.toBe(publishedAfterApply.id);

    // The agent's own current_version_id still points at the original
    // published version - applying an improvement never silently
    // switches production traffic to the new draft.
    const agentRow = fake.tables.ai_agents.find((a) => a.id === agent.id)!;
    expect(agentRow.current_version_id).toBe(agentVersion.id);

    // Applying twice is refused (already 'applied', not 'approved').
    const applyAgain = await app.inject({ method: 'POST', url: `/api/v1/agent-improvements/${improvementId}/apply`, headers: { authorization: `Bearer ${token}` } });
    expect(applyAgain.statusCode).toBe(422);

    const auditEntry = fake.tables.audit_logs.find((a) => a.action === 'agent_improvement.applied' && a.entity_id === improvementId);
    expect(auditEntry).toBeTruthy();
    expect(auditEntry!.old_value.system_prompt).toBe(originalPublishedPrompt);
    expect(auditEntry!.new_value.system_prompt).toContain(LLM_SUGGESTION.suggested_change);
  });

  it('cross-org isolation: org B can never see org A\'s call evaluations or improvements', async () => {
    const tokenA = await signup('Iso Eval Org A', `isoevala-${Date.now()}@test.com`);
    const tokenB = await signup('Iso Eval Org B', `isoevalb-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(tokenA);
    const { call } = await dialOnAgent(tokenA, agent.id, phoneNumber.id);
    await waitFor(() => fake.tables.call_evaluations.some((e) => e.call_id === call.id));
    await waitFor(() => fake.tables.ai_agent_improvements.some((i) => i.agent_id === agent.id));

    const evalFromB = await app.inject({ method: 'GET', url: `/api/v1/calls/${call.id}/evaluation`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(evalFromB.statusCode).toBe(404);

    const improvementsFromB = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/improvements`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(improvementsFromB.statusCode).toBe(404); // agent itself is org-scoped

    const summaryFromB = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/evaluation-summary`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(summaryFromB.statusCode).toBe(404);

    const improvementId = fake.tables.ai_agent_improvements.find((i) => i.agent_id === agent.id)!.id;
    const patchFromB = await app.inject({ method: 'PATCH', url: `/api/v1/agent-improvements/${improvementId}`, headers: { authorization: `Bearer ${tokenB}` }, payload: { status: 'under_review' } });
    expect(patchFromB.statusCode).toBe(404);
  });

  it('GET /agents/:id/evaluation-summary returns a real aggregate, not a fabricated one, and an honest zero state before any evaluation', async () => {
    const token = await signup('Summary Org', `summary-${Date.now()}@test.com`);
    const { agent, phoneNumber } = await setUpOrgBasics(token);

    const zeroRes = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/evaluation-summary`, headers: { authorization: `Bearer ${token}` } });
    expect(zeroRes.statusCode).toBe(200);
    expect(zeroRes.json().data.call_count).toBe(0);
    expect(zeroRes.json().data.average_overall_score).toBeNull();

    const { call } = await dialOnAgent(token, agent.id, phoneNumber.id);
    await waitFor(() => fake.tables.call_evaluations.some((e) => e.call_id === call.id));

    const summaryRes = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/evaluation-summary`, headers: { authorization: `Bearer ${token}` } });
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json().data;
    expect(summary.call_count).toBe(1);
    expect(summary.average_overall_score).toBe(60);
    expect(summary.category_averages.opening).toBe(60);
  });
});
