import { getSupabaseAdmin } from './supabase.js';
import type { RoleSummary } from '@shivanshconnect/shared';

export interface UserContext {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  status: 'active' | 'inactive';
  roles: RoleSummary[];
  permissions: string[];
}

/**
 * loadUserContext() runs on every authenticated request (it backs the
 * `authenticate` preHandler used by every route) - its 3 sequential DB
 * round trips were a fixed latency tax paid before any route's own logic
 * even started, on every button click across the whole app. Roles and
 * permission assignments change rarely, so a short in-memory cache
 * eliminates that tax on the (very common) case of the same user making
 * several requests within a few seconds - invalidated explicitly wherever
 * a user's own status/role, or a role's permissions, actually change
 * (see PATCH /users/:id and PATCH /roles/:id).
 *
 * 30s was too short in practice: a user spending more than half a minute
 * reading one page (e.g. the Dashboard) before navigating to the next
 * (e.g. Leads) let the cache expire, so that next page's first request
 * paid the full 3-round-trip tax again - reported as "Leads takes time
 * after logging in [and looking around a bit]". Explicit invalidation
 * already covers every case where staleness would actually matter, so
 * 5 minutes is a safe window: real permission/status changes take effect
 * immediately regardless of this TTL, this only bounds the worst case
 * for a change made by a different admin session with no invalidation
 * path (there isn't one currently).
 */
const USER_CONTEXT_CACHE_TTL_MS = 5 * 60_000;
const userContextCache = new Map<string, { ctx: UserContext; expiresAt: number }>();

export function invalidateUserContext(authUserId: string): void {
  userContextCache.delete(authUserId);
}

export function invalidateAllUserContexts(): void {
  userContextCache.clear();
}

export async function loadUserContext(authUserId: string): Promise<UserContext | null> {
  const cached = userContextCache.get(authUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ctx;
  }
  const ctx = await loadUserContextUncached(authUserId);
  if (ctx) {
    userContextCache.set(authUserId, { ctx, expiresAt: Date.now() + USER_CONTEXT_CACHE_TTL_MS });
  } else {
    userContextCache.delete(authUserId);
  }
  return ctx;
}

/**
 * Loads the application-level identity for a verified auth user id:
 * their public.users row, assigned roles, and the flattened set of
 * permission keys granted by those roles. Returns null if there is no
 * matching public.users row (e.g. auth user exists but signup never
 * finished, or was deleted).
 */
async function loadUserContextUncached(authUserId: string): Promise<UserContext | null> {
  const supabase = getSupabaseAdmin();

  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('id, organization_id, email, full_name, status')
    .eq('id', authUserId)
    .maybeSingle();

  if (userError) throw userError;
  if (!userRow) return null;

  const { data: userRoles, error: rolesError } = await supabase
    .from('user_roles')
    .select('role_id, roles(id, name, is_system_role)')
    .eq('user_id', authUserId);

  if (rolesError) throw rolesError;

  const roles: RoleSummary[] = (userRoles ?? [])
    .map((ur: any) => ur.roles)
    .filter(Boolean)
    .map((r: any) => ({ id: r.id, name: r.name, is_system_role: r.is_system_role }));

  const roleIds = roles.map((r) => r.id);
  let permissions: string[] = [];

  if (roleIds.length > 0) {
    const { data: rolePerms, error: permError } = await supabase
      .from('role_permissions')
      .select('permissions(key)')
      .in('role_id', roleIds);

    if (permError) throw permError;

    const keys = new Set<string>();
    for (const row of rolePerms ?? []) {
      const key = (row as any).permissions?.key;
      if (key) keys.add(key);
    }
    permissions = Array.from(keys);
  }

  return {
    id: userRow.id,
    organizationId: userRow.organization_id,
    email: userRow.email,
    fullName: userRow.full_name,
    status: userRow.status,
    roles,
    permissions,
  };
}

export function hasPermission(ctx: UserContext, permissionKey: string): boolean {
  return ctx.permissions.includes(permissionKey);
}
