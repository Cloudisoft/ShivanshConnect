import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 15: GET /api/v1/admin/health (master spec section 90).
 *
 * Real database check, real storage write+read+delete round trip, real
 * scheduler staleness reporting, and honest not_configured/connected/error
 * per-provider status derived from each provider's own real
 * test-connection status column - never a hard-coded "everything's fine".
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STORAGE_LOCAL_DIR = '.data/admin-health-test';
delete process.env.PIPECAT_SERVICE_URL;

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

describe('Phase 15: GET /admin/health', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Admin Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return res.json().data.session.access_token as string;
  }

  it('reports a real database check, a real storage round trip, and every provider as not_configured for a brand-new org', async () => {
    const token = await signup('Health Check Org', `health-${Date.now()}@test.com`);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/health', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    const byComponent = new Map(body.components.map((c: any) => [c.component, c]));
    expect((byComponent.get('database') as any).status).toBe('connected');
    expect((byComponent.get('storage') as any).status).toBe('connected');
    expect((byComponent.get('pipecat_service') as any).status).toBe('not_configured');
    expect((byComponent.get('vapi') as any).status).toBe('not_configured');
    expect((byComponent.get('twilio') as any).status).toBe('not_configured');
    expect((byComponent.get('smtp') as any).status).toBe('not_configured');
    expect(body.overall).toBe('warning'); // schedulers haven't ticked in this test process
  });

  it('reflects a real error status honestly when a provider previously failed verification', async () => {
    const token = await signup('Health Check Org 2', `health2-${Date.now()}@test.com`);
    const meRes = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    const orgId = meRes.json().data.organization.id;

    fake.tables.vapi_credentials.push({
      id: 'vc1',
      organization_id: orgId,
      encrypted_credentials: {},
      status: 'error',
      last_error: 'Invalid API key.',
      last_verified_at: new Date().toISOString(),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/health', headers: { authorization: `Bearer ${token}` } });
    const body = res.json().data;
    const byComponent = new Map(body.components.map((c: any) => [c.component, c]));
    expect((byComponent.get('vapi') as any).status).toBe('error');
    expect((byComponent.get('vapi') as any).detail).toContain('Invalid API key');
    expect(body.overall).toBe('error');
  });

  it('cross-org isolation: org B never sees org A\'s provider status', async () => {
    const tokenA = await signup('Health Org A', `health-a-${Date.now()}@test.com`);
    const meResA = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${tokenA}` } });
    const orgIdA = meResA.json().data.organization.id;
    fake.tables.vapi_credentials.push({ id: 'vcA', organization_id: orgIdA, encrypted_credentials: {}, status: 'connected', last_verified_at: new Date().toISOString() });

    const tokenB = await signup('Health Org B', `health-b-${Date.now()}@test.com`);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/health', headers: { authorization: `Bearer ${tokenB}` } });
    const body = res.json().data;
    const byComponent = new Map(body.components.map((c: any) => [c.component, c]));
    expect((byComponent.get('vapi') as any).status).toBe('not_configured');
  });

  it('requires authentication - an unauthenticated request is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/health' });
    expect(res.statusCode).toBe(401);
  });
});
