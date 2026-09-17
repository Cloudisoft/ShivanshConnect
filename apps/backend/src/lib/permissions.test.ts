import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  return { from: vi.fn() };
});

vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: mocks.from }),
}));

import { hasPermission, loadUserContext, type UserContext } from './permissions.js';

function makeQuery(result: { data: any; error: any }) {
  const query: any = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => result);
  // when awaited directly (no maybeSingle called), resolve to result
  query.then = (resolve: any) => resolve(result);
  return query;
}

describe('hasPermission', () => {
  it('returns true when the permission key is present', () => {
    const ctx: UserContext = {
      id: 'u1',
      organizationId: 'org1',
      email: 'a@b.com',
      fullName: 'A B',
      status: 'active',
      roles: [],
      permissions: ['users.manage', 'dashboard.view'],
    };
    expect(hasPermission(ctx, 'users.manage')).toBe(true);
    expect(hasPermission(ctx, 'roles.manage')).toBe(false);
  });
});

describe('loadUserContext', () => {
  beforeEach(() => {
    mocks.from.mockReset();
  });

  it('returns null when there is no matching public.users row', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'users') {
        return makeQuery({ data: null, error: null });
      }
      throw new Error(`unexpected table ${table}`);
    });

    const ctx = await loadUserContext('missing-user');
    expect(ctx).toBeNull();
  });

  it('flattens roles and permissions from user_roles -> role_permissions -> permissions', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'users') {
        return makeQuery({
          data: {
            id: 'u1',
            organization_id: 'org1',
            email: 'a@b.com',
            full_name: 'A B',
            status: 'active',
          },
          error: null,
        });
      }
      if (table === 'user_roles') {
        return makeQuery({
          data: [
            { role_id: 'role1', roles: { id: 'role1', name: 'ADMIN', is_system_role: true } },
          ],
          error: null,
        });
      }
      if (table === 'role_permissions') {
        return makeQuery({
          data: [
            { permissions: { key: 'users.manage' } },
            { permissions: { key: 'dashboard.view' } },
          ],
          error: null,
        });
      }
      throw new Error(`unexpected table ${table}`);
    });

    const ctx = await loadUserContext('u1');
    expect(ctx).not.toBeNull();
    expect(ctx!.organizationId).toBe('org1');
    expect(ctx!.roles).toEqual([{ id: 'role1', name: 'ADMIN', is_system_role: true }]);
    expect(ctx!.permissions.sort()).toEqual(['dashboard.view', 'users.manage']);
  });
});
