import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 3 integration test: agent create -> draft version -> publish ->
 * verify ai_agents.current_version_id updated + audit log written ->
 * restore creates a new draft without mutating the published version.
 * Same "mock Supabase at the DB-client boundary" approach as Phase 1/2's
 * integration tests (see leads.integration.test.ts's header for why).
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

describe('Phase 3: agent create -> draft version -> publish -> restore', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;
  let token: string;

  beforeAll(async () => {
    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();

    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Agent Test Org',
        full_name: 'Avery Agentwright',
        email: 'avery@agenttest.com',
        password: 'supersecret123',
      },
    });
    expect(signupRes.statusCode).toBe(201);
    token = signupRes.json().data.session.access_token;
  });

  it('runs the full agent + version lifecycle', async () => {
    // 1. Create the agent - starts in draft with no current version.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Sales Sam', role: 'sales_agent', description: 'Outbound sales agent' },
    });
    expect(createRes.statusCode).toBe(201);
    const agent = createRes.json().data;
    expect(agent.status).toBe('draft');
    expect(agent.current_version_id).toBeNull();

    // 2. Cannot activate an agent with no published version.
    const badActivateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${agent.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'active' },
    });
    expect(badActivateRes.statusCode).toBe(422);

    // 3. Create a draft version.
    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        system_prompt: 'You are {{first_name}}\'s sales agent.',
        greeting_template: 'Hi {{first_name}}, this is Sam calling.',
        llm_model: 'gpt-4o-mini',
      },
    });
    expect(versionRes.statusCode).toBe(201);
    const version = versionRes.json().data;
    expect(version.version_number).toBe(1);
    expect(version.status).toBe('draft');

    // 4. Publish it.
    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions/${version.id}/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.json().data.status).toBe('published');

    const agentAfterPublish = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const agentData = agentAfterPublish.json().data;
    expect(agentData.current_version_id).toBe(version.id);
    expect(agentData.status).toBe('active');
    expect(agentData.current_version.system_prompt).toContain('{{first_name}}');

    // 5. Audit log recorded the publish.
    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?action=agent_version.published',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const auditEntries = auditRes.json().data.filter((e: any) => e.entity_id === version.id);
    expect(auditEntries.length).toBeGreaterThan(0);

    // 6. A published version cannot be edited directly.
    const editPublishedRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${agent.id}/versions/${version.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'Changed!' },
    });
    expect(editPublishedRes.statusCode).toBe(422);

    // 7. Restore creates a NEW draft version, never mutating the
    // published one.
    const restoreRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions/${version.id}/restore`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(restoreRes.statusCode).toBe(201);
    const restored = restoreRes.json().data;
    expect(restored.version_number).toBe(2);
    expect(restored.status).toBe('draft');
    expect(restored.system_prompt).toBe(version.system_prompt);

    const publishedStillIntact = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.id}/versions/${version.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(publishedStillIntact.json().data.status).toBe('published');
    expect(publishedStillIntact.json().data.system_prompt).toBe(version.system_prompt);

    // 8. Versions list shows both, newest first.
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
    });
    const versions = listRes.json().data;
    expect(versions).toHaveLength(2);
    expect(versions[0].version_number).toBe(2);
    expect(versions[1].version_number).toBe(1);

    // 9. Improvements tab is honestly empty (Phase 11 populates it).
    const improvementsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.id}/improvements`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(improvementsRes.statusCode).toBe(200);
    expect(improvementsRes.json().data).toEqual([]);

    // 10. Preview without a configured LLM provider is honest, never fabricated.
    const previewRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/preview`,
      headers: { authorization: `Bearer ${token}` },
      payload: { message: 'Hi there' },
    });
    expect(previewRes.statusCode).toBe(422);
    expect(previewRes.json().error.message).toMatch(/LLM provider/i);
  });

  it('deletes a draft/archived version but never the published one or a version with call history', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Deletable Versions Agent', role: 'sales_agent' },
    });
    const agent = createRes.json().data;

    const v1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'v1 prompt' },
    });
    const v1 = v1Res.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions/${v1.id}/publish`, headers: { authorization: `Bearer ${token}` } });

    // The published version cannot be deleted.
    const deletePublishedRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${agent.id}/versions/${v1.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deletePublishedRes.statusCode).toBe(422);
    expect(fake.tables.ai_agent_versions.some((v) => v.id === v1.id)).toBe(true);

    // A version that was actually used for a call cannot be deleted either.
    fake.tables.calls.push({
      id: 'call-using-v1',
      organization_id: agent.organization_id,
      ai_agent_id: agent.id,
      ai_agent_version_id: v1.id,
      engine: 'vapi',
      direction: 'outbound',
      customer_number: '+15550000001',
      status: 'completed',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Publishing v2 archives v1, so the "published" rejection no longer
    // applies - the call-history check is what must now block it.
    const v2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'v2 prompt' },
    });
    const v2 = v2Res.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/versions/${v2.id}/publish`, headers: { authorization: `Bearer ${token}` } });

    const archivedV1 = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/versions/${v1.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(archivedV1.json().data.status).toBe('archived');

    const deleteWithHistoryRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${agent.id}/versions/${v1.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteWithHistoryRes.statusCode).toBe(409);
    expect(deleteWithHistoryRes.json().error.message).toMatch(/1 call/i);
    expect(fake.tables.ai_agent_versions.some((v) => v.id === v1.id)).toBe(true);

    // A draft/archived version with NO call history deletes cleanly.
    const v3Res = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'v3 prompt, never used' },
    });
    const v3 = v3Res.json().data;
    expect(v3.status).toBe('draft');

    const deleteDraftRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${agent.id}/versions/${v3.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteDraftRes.statusCode).toBe(200);
    expect(deleteDraftRes.json().data.deleted).toBe(true);
    expect(fake.tables.ai_agent_versions.some((v) => v.id === v3.id)).toBe(false);
  });

  it('rejects cross-tenant access to an agent', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Private Agent', role: 'support_agent' },
    });
    const agentId = createRes.json().data.id;

    const otherSignup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Other Agent Org',
        full_name: 'Otto Outsider',
        email: 'otto@otheragent.com',
        password: 'supersecret123',
      },
    });
    const otherToken = otherSignup.json().data.session.access_token;

    const crossRes = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agentId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(crossRes.statusCode).toBe(404);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('publishing a version automatically syncs a Vapi assistant when the org has Vapi connected', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.vapi.ai/assistant' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 'asst_from_publish' }) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call in test: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const vapiCredsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vapi/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { api_key: 'vapi-test-key' },
    });
    expect(vapiCredsRes.statusCode).toBe(200);

    const agentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Vapi-Synced Agent', role: 'sales_agent' },
    });
    const agentId = agentRes.json().data.id;

    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/versions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: 'You are a helpful sales agent.', greeting_template: 'Hi there!', llm_model: 'gpt-4o-mini' },
    });
    const versionId = versionRes.json().data.id;

    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/versions/${versionId}/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.json().data.vapi_assistant_id).toBe('asst_from_publish');
    expect(publishRes.json().message).toMatch(/synced with vapi/i);
  });
});
