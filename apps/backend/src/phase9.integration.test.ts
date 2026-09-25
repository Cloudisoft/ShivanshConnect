import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 9 integration tests: a call reaching a terminal state drives the
 * real artifact-ingestion pipeline (services/processCallArtifacts.ts +
 * services/generateCallSummary.ts) end to end, and the resulting CDR
 * list/detail/export APIs reflect exactly what was ingested. Same
 * fakeSupabase harness and app.inject() pattern as every prior phase's
 * integration test.
 *
 * Test-only mocks (documented, never shipped): the orchestration
 * provider's outbound HTTP calls (Vapi's REST API) and the recording
 * download URL are both served by one stubbed `global.fetch`, and the
 * LLM summary call is served by the same stub against
 * https://api.openai.com - OPENAI_API_KEY is set to a fake test value
 * purely so lib/llm/openai.ts's isConfigured check passes.
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

const RECORDING_URL = 'https://recordings.example.com/rec-1.mp3';
const RECORDING_BYTES = Buffer.from('fake-mp3-bytes-for-test');
const FLAT_TRANSCRIPT = 'AI: Hi, this is Alex calling from Acme.\nUser: Hi, sure I have a minute.\nAI: Great, are you still interested in a quote?\nUser: Yes, please send it over.';
const LLM_SUMMARY = {
  summary: 'Caller confirmed interest and asked for a quote to be sent.',
  key_points: ['Confirmed interest', 'Requested a quote'],
  customer_intent: 'Get a quote',
  objections: [],
  questions: [],
  next_action: 'Send the quote by email',
  outcome: 'Positive - quote requested',
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

describe('Phase 9: CDR artifact ingestion pipeline + CDR/export APIs', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;
  let processCampaign: typeof import('./services/campaignDispatcher.js').processCampaign;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === 'https://api.vapi.ai/assistant' && method === 'POST') {
        vapiAssistantCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p9_asst_${vapiAssistantCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
        vapiPhoneNumberCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p9_vapi_pn_${vapiPhoneNumberCounter}` }) } as unknown as Response;
      }
      if (url === 'https://api.vapi.ai/call' && method === 'POST') {
        vapiCallCounter += 1;
        return { ok: true, status: 200, json: async () => ({ id: `p9_vapi_call_${vapiCallCounter}`, status: 'queued' }) } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/assistant?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.startsWith('https://api.vapi.ai/call/') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: url.split('/').pop(),
            status: 'ended',
            artifact: { recordingUrl: RECORDING_URL, transcript: FLAT_TRANSCRIPT, transcriptUrl: null },
          }),
        } as unknown as Response;
      }
      if (url === RECORDING_URL) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
          arrayBuffer: async () => RECORDING_BYTES.buffer.slice(RECORDING_BYTES.byteOffset, RECORDING_BYTES.byteOffset + RECORDING_BYTES.byteLength),
        } as unknown as Response;
      }
      if (url === 'https://api.openai.com/v1/chat/completions' && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ model: 'gpt-4o-mini', choices: [{ message: { content: JSON.stringify(LLM_SUMMARY) } }] }),
        } as unknown as Response;
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
    const agentRes = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Campaign Agent', role: 'sales_agent' } });
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
      payload: { provider_key: 'byon', phone_number: `+1484556${Math.floor(1000 + Math.random() * 8999)}`, capabilities: { voice_inbound: true, voice_outbound: true, sms: false }, sip_trunk_metadata: { host: 'sip.example.com', username: 'trunk-user', password: 'trunk-secret' } },
    });
    const phoneNumber = importRes.json().data;
    return { agent, agentVersion, phoneNumber };
  }

  async function createCampaignWithOneLead(token: string, agentId: string, phoneNumberId: string) {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/campaigns', headers: { authorization: `Bearer ${token}` }, payload: { name: `P9 Campaign ${Date.now()}-${Math.random()}`, phone_number_id: phoneNumberId, concurrency_limit: 5, transfer_number_e164: '+14845550099' } });
    const campaign = createRes.json().data;
    const listRes = await app.inject({ method: 'POST', url: '/api/v1/lead-lists', headers: { authorization: `Bearer ${token}` }, payload: { name: `P9 List ${Date.now()}-${Math.random()}` } });
    const list = listRes.json().data;
    const numbers = [`+1202555${Math.floor(1000 + Math.random() * 8999)}`];
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
    return { campaign, list };
  }

  async function dialAndCompleteOneCall(token: string) {
    const { agent, phoneNumber } = await setUpOrgBasics(token);
    const { campaign } = await createCampaignWithOneLead(token, agent.id, phoneNumber.id);

    const result = await processCampaign(fake.tables.campaigns.find((c) => c.id === campaign.id)!);
    expect(result.dispatched).toBe(1);

    const cl = fake.tables.campaign_leads.find((r) => r.campaign_id === campaign.id)!;
    const call = fake.tables.calls.find((c) => c.id === cl.last_call_id)!;

    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'status-update', status: 'in-progress', call: { id: call.vapi_call_id } } } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/vapi', payload: { message: { type: 'end-of-call-report', call: { id: call.vapi_call_id }, endedReason: 'customer-ended-call', durationSeconds: 90 } } });

    return { call };
  }

  it('ingests a real transcript (segmented), a real recording, and generates a real AI summary once a call ends', async () => {
    const token = await signup('CDR Org', `cdr-${Date.now()}@test.com`);
    const { call } = await dialAndCompleteOneCall(token);

    await waitFor(() => fake.tables.call_transcripts.some((t) => t.call_id === call.id && t.status === 'ready'));
    await waitFor(() => fake.tables.call_recordings.some((r) => r.call_id === call.id && r.status === 'ready'));
    await waitFor(() => fake.tables.call_summaries.some((s) => s.call_id === call.id));

    const transcript = fake.tables.call_transcripts.find((t) => t.call_id === call.id)!;
    expect(transcript.full_text).toBe(FLAT_TRANSCRIPT);

    const segments = fake.tables.call_transcript_segments.filter((s) => s.transcript_id === transcript.id).sort((a, b) => a.segment_index - b.segment_index);
    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ speaker: 'ai', segment_index: 0 });
    expect(segments[1]).toMatchObject({ speaker: 'caller', segment_index: 1 });

    const recording = fake.tables.call_recordings.find((r) => r.call_id === call.id)!;
    expect(recording.storage_path).toBeTruthy();
    expect(recording.size_bytes).toBe(RECORDING_BYTES.length);
    expect(recording.provider_recording_url).toBe(RECORDING_URL);

    const summary = fake.tables.call_summaries.find((s) => s.call_id === call.id)!;
    expect(summary.summary).toBe(LLM_SUMMARY.summary);
    expect(summary.key_points).toEqual(LLM_SUMMARY.key_points);
    expect(summary.next_action).toBe(LLM_SUMMARY.next_action);
  });

  it('GET /cdr and GET /cdr/:callId reflect the ingested artifacts', async () => {
    const token = await signup('CDR List Org', `cdrlist-${Date.now()}@test.com`);
    const { call } = await dialAndCompleteOneCall(token);
    await waitFor(() => fake.tables.call_summaries.some((s) => s.call_id === call.id));

    const listRes = await app.inject({ method: 'GET', url: '/api/v1/cdr', headers: { authorization: `Bearer ${token}` } });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    const row = listBody.data.find((r: any) => r.call_id === call.id);
    expect(row).toBeTruthy();
    expect(row.has_transcript).toBe(true);
    expect(row.has_recording).toBe(true);
    expect(row.has_summary).toBe(true);
    expect(row.disposition_code).toBe('CALL_CONNECTED');

    const detailRes = await app.inject({ method: 'GET', url: `/api/v1/cdr/${call.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json().data;
    expect(detail.transcript.status).toBe('ready');
    expect(detail.transcript_segments).toHaveLength(4);
    expect(detail.recording.playback_url).toBe(`/api/v1/cdr/${call.id}/recording/download`);
    expect(detail.summary.summary).toBe(LLM_SUMMARY.summary);
  });

  it('GET /cdr/:callId/recording/download returns the real downloaded bytes', async () => {
    const token = await signup('CDR Download Org', `cdrdl-${Date.now()}@test.com`);
    const { call } = await dialAndCompleteOneCall(token);
    await waitFor(() => fake.tables.call_recordings.some((r) => r.call_id === call.id && r.status === 'ready'));

    const downloadRes = await app.inject({ method: 'GET', url: `/api/v1/cdr/${call.id}/recording/download`, headers: { authorization: `Bearer ${token}` } });
    expect(downloadRes.statusCode).toBe(200);
    expect(Buffer.from(downloadRes.rawPayload)).toEqual(RECORDING_BYTES);
  });

  it('GET /cdr/search-transcript finds the call by transcript content', async () => {
    const token = await signup('CDR Search Org', `cdrsearch-${Date.now()}@test.com`);
    const { call } = await dialAndCompleteOneCall(token);
    await waitFor(() => fake.tables.call_transcripts.some((t) => t.call_id === call.id && t.status === 'ready'));

    const searchRes = await app.inject({ method: 'GET', url: '/api/v1/cdr/search-transcript?q=quote', headers: { authorization: `Bearer ${token}` } });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().data.some((r: any) => r.call_id === call.id)).toBe(true);
  });

  it('POST /cdr/export queues a background job that produces a real CSV file with the correct row count', async () => {
    const token = await signup('CDR Export Org', `cdrexport-${Date.now()}@test.com`);
    const { call } = await dialAndCompleteOneCall(token);
    await waitFor(() => fake.tables.call_summaries.some((s) => s.call_id === call.id));

    const exportRes = await app.inject({ method: 'POST', url: '/api/v1/cdr/export', headers: { authorization: `Bearer ${token}` }, payload: { type: 'cdr_csv', filters: {} } });
    expect(exportRes.statusCode).toBe(200);
    const exportId = exportRes.json().data.id;
    // Returns immediately - never processed synchronously in the request.
    expect(['pending', 'processing']).toContain(fake.tables.exports.find((e) => e.id === exportId)!.status);

    await waitFor(() => fake.tables.exports.find((e) => e.id === exportId)?.status === 'ready');
    const exportRow = fake.tables.exports.find((e) => e.id === exportId)!;
    expect(exportRow.row_count).toBe(1);

    const downloadRes = await app.inject({ method: 'GET', url: `/api/v1/exports/${exportId}/download`, headers: { authorization: `Bearer ${token}` } });
    expect(downloadRes.statusCode).toBe(200);
    const csv = downloadRes.rawPayload.toString('utf-8');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2); // header + 1 row
    expect(csv).toContain(call.id);

    const auditEntry = fake.tables.audit_logs.find((a) => a.action === 'cdr.export_created' && a.entity_id === exportId);
    expect(auditEntry).toBeTruthy();
  });

  it('cross-org isolation: org B can never see org A\'s CDR rows, transcripts, recordings or exports, even via a guessed id', async () => {
    const tokenA = await signup('Iso CDR Org A', `isocdra-${Date.now()}@test.com`);
    const tokenB = await signup('Iso CDR Org B', `isocdrb-${Date.now()}@test.com`);
    const { call } = await dialAndCompleteOneCall(tokenA);
    await waitFor(() => fake.tables.call_summaries.some((s) => s.call_id === call.id));

    const listFromB = await app.inject({ method: 'GET', url: '/api/v1/cdr', headers: { authorization: `Bearer ${tokenB}` } });
    expect(listFromB.json().data).toHaveLength(0);

    const detailFromB = await app.inject({ method: 'GET', url: `/api/v1/cdr/${call.id}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(detailFromB.statusCode).toBe(404);

    const downloadFromB = await app.inject({ method: 'GET', url: `/api/v1/cdr/${call.id}/recording/download`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(downloadFromB.statusCode).toBe(404);

    const exportRes = await app.inject({ method: 'POST', url: '/api/v1/cdr/export', headers: { authorization: `Bearer ${tokenA}` }, payload: { type: 'cdr_csv', filters: {} } });
    const exportId = exportRes.json().data.id;
    await waitFor(() => fake.tables.exports.find((e) => e.id === exportId)?.status === 'ready');

    const exportStatusFromB = await app.inject({ method: 'GET', url: `/api/v1/exports/${exportId}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(exportStatusFromB.statusCode).toBe(404);

    const exportDownloadFromB = await app.inject({ method: 'GET', url: `/api/v1/exports/${exportId}/download`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(exportDownloadFromB.statusCode).toBe(404);

    const exportsListFromB = await app.inject({ method: 'GET', url: '/api/v1/exports', headers: { authorization: `Bearer ${tokenB}` } });
    expect(exportsListFromB.json().data).toHaveLength(0);
  });
});
