import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Integration test: signup -> invite user -> accept invite -> role
 * change -> audit log entry appears.
 *
 * No live Supabase project or local Docker Supabase stack was available
 * in this sandbox (see README "Verification notes"), so this test mocks
 * Supabase at the DB-client boundary (see src/test/fakeSupabase.ts) and
 * drives the real Fastify route handlers end-to-end over HTTP via
 * app.inject(). Row Level Security itself was verified separately by
 * applying every migration to a real local PostgreSQL 16 instance.
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

describe('signup -> invite -> accept -> role change -> audit log', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  it('runs the full flow and leaves a matching audit trail', async () => {
    // 1. Signup - creates the organization and the SUPER_ADMIN user.
    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Acme Contact Center',
        full_name: 'Ada Admin',
        email: 'ada@acme.com',
        password: 'supersecret123',
      },
    });
    expect(signupRes.statusCode).toBe(201);
    const signupBody = signupRes.json();
    expect(signupBody.success).toBe(true);
    const adminToken = signupBody.data.session.access_token;
    const orgId = signupBody.data.organization.id;

    // 2. Find the VIEWER system role id to invite a teammate into.
    const viewerRole = fake.tables.roles.find((r) => r.name === 'VIEWER' && r.is_system_role);
    expect(viewerRole).toBeTruthy();

    // 3. Invite a teammate.
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'bob@acme.com', role_id: viewerRole!.id },
    });
    expect(inviteRes.statusCode).toBe(201);
    const inviteBody = inviteRes.json();
    const invitationToken = inviteBody.data.invitation.token;
    expect(invitationToken).toBeTruthy();

    // 4. Bob accepts the invitation.
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invitation',
      payload: { token: invitationToken, full_name: 'Bob Agent', password: 'anothersecret123' },
    });
    expect(acceptRes.statusCode).toBe(200);
    const acceptBody = acceptRes.json();
    expect(acceptBody.data.account_created).toBe(true);
    const bobUserId = fake.tables.users.find((u) => u.email === 'bob@acme.com')!.id;

    // 5. Admin promotes Bob to ADMIN.
    const adminRole = fake.tables.roles.find((r) => r.name === 'ADMIN' && r.is_system_role)!;
    const roleChangeRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${bobUserId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role_id: adminRole.id },
    });
    expect(roleChangeRes.statusCode).toBe(200);
    const roleChangeBody = roleChangeRes.json();
    expect(roleChangeBody.data.roles.some((r: any) => r.id === adminRole.id)).toBe(true);

    // 6. Every mutation above must have written an audit_logs row.
    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const auditBody = auditRes.json();
    const actions = auditBody.data.map((entry: any) => entry.action);
    expect(actions).toContain('user.invited');
    expect(actions).toContain('user.invitation_accepted');
    expect(actions).toContain('user.role_changed');
    expect(auditBody.data.every((entry: any) => entry.organization_id === orgId)).toBe(true);
  });

  it('rejects a tenant-isolation violation: org B cannot patch org A\'s user', async () => {
    // A second, unrelated organization + admin.
    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Other Org',
        full_name: 'Eve Outsider',
        email: 'eve@other.com',
        password: 'supersecret123',
      },
    });
    const otherToken = signupRes.json().data.session.access_token;

    const acmeUser = fake.tables.users.find((u) => u.email === 'ada@acme.com')!;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${acmeUser.id}`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { full_name: 'Hijacked Name' },
    });

    // Cross-org access must never succeed - 404 (resource not visible to
    // this org) rather than leaking whether the id exists elsewhere.
    expect(res.statusCode).toBe(404);
  });
});
