import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';
import type { EmbedTextResult, GenerateTextResult, LlmProviderAdapter } from './lib/llm/types.js';

/**
 * Phase 3 integration test: upload a small TXT knowledge document ->
 * async processing (services/processKnowledgeDocument.ts, driven by the
 * same setImmediate hand-off used everywhere in this build) -> verify
 * chunks were created and the document reaches status=ready -> retrieval
 * via POST /agents/:id/knowledge/search finds the right chunk -> a
 * second organization's search for the exact same query never returns
 * the first organization's chunks, even though both requests are
 * legitimately authenticated and hit real route/RPC code.
 *
 * TEST-ONLY: the OpenAI embedding call is mocked at the LLM provider
 * adapter boundary (lib/llm/index.ts's __setLlmProviderForTests) so this
 * test doesn't need a real OPENAI_API_KEY or network access. This is not
 * shipped app behavior - the real OpenAIProvider (lib/llm/openai.ts) is
 * exercised directly and unmocked in lib/llm/openai.test.ts.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

/** Deterministic, content-derived fake embedding: hashes each word into
 * one of 1536 dimensions and bumps it, so semantically similar text
 * (sharing words) scores higher cosine similarity than unrelated text -
 * good enough to prove retrieval actually discriminates, without needing
 * a real embedding model. */
function fakeEmbed(text: string): number[] {
  const vec = new Array(1536).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i += 1) hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    vec[hash % 1536] += 1;
  }
  return vec;
}

class FakeLlmProvider implements LlmProviderAdapter {
  readonly name = 'fake';
  readonly isConfigured = true;
  async generateText(): Promise<GenerateTextResult> {
    return { text: 'fake reply', model: 'fake-model' };
  }
  async embedText(texts: string[]): Promise<EmbedTextResult> {
    return { embeddings: texts.map(fakeEmbed), model: 'fake-embedding', dimensions: 1536 };
  }
}

function buildMultipartFile(fileName: string, content: string, contentType = 'text/plain'): { body: Buffer; contentType: string } {
  const boundary = '----phase3TestBoundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return { body: Buffer.from(body), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function waitForDocStatus(
  app: Awaited<ReturnType<typeof import('./index.js').buildApp>>,
  token: string,
  kbId: string,
  docId: string,
  targetStatuses: string[],
  maxAttempts = 50,
): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/knowledge-bases/${kbId}/documents`,
      headers: { authorization: `Bearer ${token}` },
    });
    const doc = res.json().data.find((d: any) => d.id === docId);
    if (doc && targetStatuses.includes(doc.status)) return doc;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Document ${docId} did not reach status ${targetStatuses.join('/')} in time`);
}

describe('Phase 3: knowledge document upload -> process -> retrieve, cross-org isolation', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const llm = await import('./lib/llm/index.js');
    llm.__setLlmProviderForTests(new FakeLlmProvider());

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  it('processes an upload into ready chunks and retrieves them by similarity', async () => {
    // Org A setup.
    const signupA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Knowledge Org A',
        full_name: 'Kara Knowlesworth',
        email: 'kara@knowledgetest.com',
        password: 'supersecret123',
      },
    });
    const tokenA = signupA.json().data.session.access_token;

    const agentA = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Support Agent A', role: 'support_agent' },
    });
    const agentAId = agentA.json().data.id;

    const kbA = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge-bases',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Org A KB', agent_id: agentAId },
    });
    expect(kbA.statusCode).toBe(201);
    const kbAId = kbA.json().data.id;

    // Upload a small TXT document.
    const { body, contentType } = buildMultipartFile(
      'return-policy.txt',
      'Our return policy allows returns within thirty days of purchase for a full refund. ' +
        'Alpaca wool sweaters are exempt from returns due to hygiene reasons.',
    );
    const uploadRes = await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge-bases/${kbAId}/documents`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': contentType },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(202);
    const docId = uploadRes.json().data.id;

    const readyDoc = await waitForDocStatus(app, tokenA, kbAId, docId, ['ready', 'failed']);
    expect(readyDoc.status).toBe('ready');
    expect(readyDoc.error_message).toBeNull();

    // Chunks were actually created and embedded.
    const chunks = fake.tables.knowledge_chunks.filter((c: any) => c.document_id === docId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].embedding).toHaveLength(1536);

    // Retrieval finds the return-policy chunk for a related query.
    const searchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentAId}/knowledge/search`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { query: 'What is your return policy for alpaca sweaters?', top_k: 3 },
    });
    expect(searchRes.statusCode).toBe(200);
    const results = searchRes.json().data;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toMatch(/return policy|alpaca/i);
    expect(results[0].document_file_name).toBe('return-policy.txt');

    // ---------------------------------------------------------------
    // Org B: legitimately authenticated, its own agent, but must never
    // see org A's chunks - even asking the exact same question.
    // ---------------------------------------------------------------
    const signupB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Knowledge Org B',
        full_name: 'Bo Bystander',
        email: 'bo@knowledgetest.com',
        password: 'supersecret123',
      },
    });
    const tokenB = signupB.json().data.session.access_token;

    const agentB = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: 'Support Agent B', role: 'support_agent' },
    });
    const agentBId = agentB.json().data.id;

    const crossSearchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentBId}/knowledge/search`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { query: 'What is your return policy for alpaca sweaters?', top_k: 5 },
    });
    expect(crossSearchRes.statusCode).toBe(200);
    expect(crossSearchRes.json().data).toEqual([]);

    // Org B cannot even address org A's agent id directly (guessed/known id).
    const guessedIdRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentAId}/knowledge/search`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { query: 'return policy', top_k: 5 },
    });
    expect(guessedIdRes.statusCode).toBe(404);

    // Deleting the document removes its chunks too.
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/knowledge-bases/${kbAId}/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(fake.tables.knowledge_chunks.filter((c: any) => c.document_id === docId)).toHaveLength(0);
  });

  it('marks a document failed with an honest message when no embedding provider is configured', async () => {
    const llm = await import('./lib/llm/index.js');
    llm.__setLlmProviderForTests({
      name: 'unconfigured',
      isConfigured: false,
      async generateText(): Promise<GenerateTextResult> {
        throw new Error('not configured');
      },
      async embedText(): Promise<EmbedTextResult> {
        throw new Error('not configured');
      },
    } as LlmProviderAdapter);

    try {
      const signup = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: {
          organization_name: 'No Provider Org',
          full_name: 'Nora Noprovider',
          email: 'nora@noprovidertest.com',
          password: 'supersecret123',
        },
      });
      const token = signup.json().data.session.access_token;

      const kb = await app.inject({
        method: 'POST',
        url: '/api/v1/knowledge-bases',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'No Provider KB' },
      });
      const kbId = kb.json().data.id;

      const { body, contentType } = buildMultipartFile('doc.txt', 'Some plain text content to embed.');
      const uploadRes = await app.inject({
        method: 'POST',
        url: `/api/v1/knowledge-bases/${kbId}/documents`,
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        payload: body,
      });
      const docId = uploadRes.json().data.id;

      const failedDoc = await waitForDocStatus(app, token, kbId, docId, ['ready', 'failed']);
      expect(failedDoc.status).toBe('failed');
      expect(failedDoc.error_message).toMatch(/embedding provider|OPENAI_API_KEY/i);
    } finally {
      llm.__setLlmProviderForTests(new FakeLlmProvider());
    }
  });
});
