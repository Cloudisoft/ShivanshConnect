import { beforeAll, describe, expect, it, vi } from 'vitest';
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
        system_prompt: 'You are {{first_name}}\'s sales agent from {{company}}.',
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
});
