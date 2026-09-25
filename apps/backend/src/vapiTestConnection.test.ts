import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Regression coverage for a real production incident: BACKEND_PUBLIC_URL
 * being unset silently skipped Vapi webhook registration entirely while
 * POST /vapi/test-connection still reported 'connected' - every call
 * placed under that state got stuck at 'dialing' forever, since Vapi had
 * nowhere to send status-update/end-of-call-report events, and nothing
 * anywhere (System Health, this endpoint's own response) explained why.
 *
 * (The BACKEND_PUBLIC_URL-set -> 'connected' path is already covered by
 * campaigns.integration.test.ts's main lifecycle test. getEnv() caches
 * process.env once per process, so that case can't also be exercised in
 * this file without a second process - hence the split.)
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.BACKEND_PUBLIC_URL;

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

describe('POST /vapi/test-connection - webhook registration', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://api.vapi.ai/assistant?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./index.js');
    app = await mod.buildApp();
  });

  it('reports a real \'error\' (never a silent \'connected\') when BACKEND_PUBLIC_URL is unset, since the call-status webhook can never be registered', async () => {
    const signupRes = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: 'No Public URL Org', full_name: 'Test Person', email: `no-public-url-${Date.now()}@test.com`, password: 'supersecret123' } });
    expect(signupRes.statusCode).toBe(201);
    const token = signupRes.json().data.session.access_token as string;

    await app.inject({ method: 'POST', url: '/api/v1/vapi/credentials', headers: { authorization: `Bearer ${token}` }, payload: { api_key: 'sk-vapi-test' } });

    const res = await app.inject({ method: 'POST', url: '/api/v1/vapi/test-connection', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('error');
    expect(res.json().data.last_error).toContain('BACKEND_PUBLIC_URL');
    expect(res.json().data.webhook_url).toBeFalsy();
  });
});
