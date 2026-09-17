import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ auth: { getUser: mocks.getUser } }),
}));

const loadUserContextMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/permissions.js')>('../lib/permissions.js');
  return { ...actual, loadUserContext: loadUserContextMock };
});

import { assertSameOrganization, authenticate, requirePermission } from './auth.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

function makeReq(headers: Record<string, string> = {}): any {
  return { headers, user: undefined };
}

describe('authenticate', () => {
  beforeEach(() => {
    mocks.getUser.mockReset();
    loadUserContextMock.mockReset();
  });

  it('rejects requests with no Authorization header', async () => {
    await expect(authenticate(makeReq(), {} as any)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an invalid/expired JWT', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
    await expect(
      authenticate(makeReq({ authorization: 'Bearer bad-token' }), {} as any),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a deactivated user', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    loadUserContextMock.mockResolvedValue({
      id: 'u1',
      organizationId: 'org1',
      email: 'a@b.com',
      fullName: 'A',
      status: 'inactive',
      roles: [],
      permissions: [],
    });
    await expect(
      authenticate(makeReq({ authorization: 'Bearer good-token' }), {} as any),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('attaches req.user with the resolved organization and permissions on success', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    loadUserContextMock.mockResolvedValue({
      id: 'u1',
      organizationId: 'org1',
      email: 'a@b.com',
      fullName: 'A',
      status: 'active',
      roles: [],
      permissions: ['users.manage'],
    });
    const req = makeReq({ authorization: 'Bearer good-token' });
    await authenticate(req, {} as any);
    expect(req.user.organizationId).toBe('org1');
    expect(req.user.permissions).toEqual(['users.manage']);
  });
});

describe('requirePermission', () => {
  it('throws Forbidden when the user lacks the permission', async () => {
    const req = makeReq();
    req.user = { permissions: ['dashboard.view'] };
    await expect(requirePermission('users.manage')(req, {} as any)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('passes when the user has the permission', async () => {
    const req = makeReq();
    req.user = { permissions: ['users.manage'] };
    await expect(requirePermission('users.manage')(req, {} as any)).resolves.toBeUndefined();
  });
});

describe('assertSameOrganization (tenant isolation defense-in-depth)', () => {
  it('throws when a resource belongs to a different organization than the caller', () => {
    // Simulates: a request for org A's user_id via org B's session.
    expect(() => assertSameOrganization('org-A', 'org-B')).toThrow(ForbiddenError);
  });

  it('passes when the resource organization matches the caller organization', () => {
    expect(() => assertSameOrganization('org-A', 'org-A')).not.toThrow();
  });
});
