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
 * Loads the application-level identity for a verified auth user id:
 * their public.users row, assigned roles, and the flattened set of
 * permission keys granted by those roles. Returns null if there is no
 * matching public.users row (e.g. auth user exists but signup never
 * finished, or was deleted).
 */
export async function loadUserContext(authUserId: string): Promise<UserContext | null> {
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
