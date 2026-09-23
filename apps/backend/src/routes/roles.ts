import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { createRoleSchema, roleIdParamSchema, updateRoleSchema } from '../schemas/roles.js';
import { invalidateAllUserContexts } from '../lib/permissions.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

async function fetchRoleWithPermissions(supabase: ReturnType<typeof getSupabaseAdmin>, roleId: string) {
  const { data: role, error } = await supabase
    .from('roles')
    .select('id, organization_id, name, is_system_role, created_at')
    .eq('id', roleId)
    .maybeSingle();
  if (error) throw error;
  if (!role) return null;

  const { data: perms, error: permError } = await supabase
    .from('role_permissions')
    .select('permissions(key)')
    .eq('role_id', roleId);
  if (permError) throw permError;

  return {
    ...role,
    permissions: (perms ?? []).map((p: any) => p.permissions?.key).filter(Boolean),
  };
}

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('roles.manage'));

  // ---------------------------------------------------------------
  // GET /api/v1/roles - system roles + this org's custom roles
  // ---------------------------------------------------------------
  app.get('/', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: roles, error } = await supabase
      .from('roles')
      .select('id, organization_id, name, is_system_role, created_at')
      .or(`is_system_role.eq.true,organization_id.eq.${orgId}`)
      .order('is_system_role', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw error;

    const roleIds = (roles ?? []).map((r) => r.id);
    const { data: rolePerms, error: permError } = await supabase
      .from('role_permissions')
      .select('role_id, permissions(key)')
      .in('role_id', roleIds.length > 0 ? roleIds : ['00000000-0000-0000-0000-000000000000']);
    if (permError) throw permError;

    const byRole = new Map<string, string[]>();
    for (const row of rolePerms ?? []) {
      const key = (row as any).permissions?.key;
      if (!key) continue;
      const list = byRole.get((row as any).role_id) ?? [];
      list.push(key);
      byRole.set((row as any).role_id, list);
    }

    return ok(
      (roles ?? []).map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] })),
    );
  });

  // ---------------------------------------------------------------
  // POST /api/v1/roles - create a custom org-level role
  // ---------------------------------------------------------------
  app.post('/', async (req, reply) => {
    const body = createRoleSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: role, error: roleError } = await supabase
      .from('roles')
      .insert({ organization_id: orgId, name: body.name, is_system_role: false })
      .select('id, organization_id, name, is_system_role, created_at')
      .single();
    if (roleError) {
      if ((roleError as any).code === '23505') {
        throw new ConflictError('A role with this name already exists.');
      }
      throw roleError;
    }

    if (body.permission_keys.length > 0) {
      const { data: perms, error: permError } = await supabase
        .from('permissions')
        .select('id, key')
        .in('key', body.permission_keys);
      if (permError) throw permError;
      const unknown = body.permission_keys.filter((k) => !(perms ?? []).some((p) => p.key === k));
      if (unknown.length > 0) {
        throw new ValidationError(`Unknown permission keys: ${unknown.join(', ')}`);
      }
      const { error: linkError } = await supabase
        .from('role_permissions')
        .insert((perms ?? []).map((p) => ({ role_id: role.id, permission_id: p.id })));
      if (linkError) throw linkError;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.ROLE_CREATED,
      entityType: 'role',
      entityId: role.id,
      newValue: { name: body.name, permission_keys: body.permission_keys },
      ipAddress: req.ip,
    });

    const full = await fetchRoleWithPermissions(supabase, role.id);
    return reply.status(201).send(ok(full, { message: 'Role created.' }));
  });

  // ---------------------------------------------------------------
  // PATCH /api/v1/roles/:id - rename / change permissions (custom roles only)
  // ---------------------------------------------------------------
  app.patch('/:id', async (req) => {
    const { id } = roleIdParamSchema.parse(req.params);
    const body = updateRoleSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const existing = await fetchRoleWithPermissions(supabase, id);
    if (!existing) throw new NotFoundError('Role not found.');
    if (existing.is_system_role) {
      throw new ForbiddenError('System roles cannot be edited.');
    }
    if (existing.organization_id !== orgId) {
      throw new NotFoundError('Role not found.');
    }

    if (body.name !== undefined) {
      const { error } = await supabase.from('roles').update({ name: body.name }).eq('id', id);
      if (error) {
        if ((error as any).code === '23505') throw new ConflictError('A role with this name already exists.');
        throw error;
      }
    }

    if (body.permission_keys !== undefined) {
      const { data: perms, error: permError } = await supabase
        .from('permissions')
        .select('id, key')
        .in('key', body.permission_keys.length > 0 ? body.permission_keys : ['__none__']);
      if (permError) throw permError;
      const unknown = body.permission_keys.filter((k) => !(perms ?? []).some((p) => p.key === k));
      if (unknown.length > 0) {
        throw new ValidationError(`Unknown permission keys: ${unknown.join(', ')}`);
      }

      await supabase.from('role_permissions').delete().eq('role_id', id);
      if ((perms ?? []).length > 0) {
        const { error: linkError } = await supabase
          .from('role_permissions')
          .insert((perms ?? []).map((p) => ({ role_id: id, permission_id: p.id })));
        if (linkError) throw linkError;
      }
      // Every user holding this role is affected, and we don't track which
      // - clear the whole cache rather than let stale permissions linger.
      invalidateAllUserContexts();

      await writeAuditLog({
        organizationId: orgId,
        userId: req.user!.id,
        action: AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
        entityType: 'role',
        entityId: id,
        oldValue: { permissions: existing.permissions },
        newValue: { permissions: body.permission_keys },
        ipAddress: req.ip,
      });
    } else {
      await writeAuditLog({
        organizationId: orgId,
        userId: req.user!.id,
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        entityType: 'role',
        entityId: id,
        oldValue: { name: existing.name },
        newValue: { name: body.name },
        ipAddress: req.ip,
      });
    }

    const full = await fetchRoleWithPermissions(supabase, id);
    return ok(full);
  });

  // ---------------------------------------------------------------
  // DELETE /api/v1/roles/:id - delete a custom role (must be unassigned)
  // ---------------------------------------------------------------
  app.delete('/:id', async (req) => {
    const { id } = roleIdParamSchema.parse(req.params);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const existing = await fetchRoleWithPermissions(supabase, id);
    if (!existing) throw new NotFoundError('Role not found.');
    if (existing.is_system_role) throw new ForbiddenError('System roles cannot be deleted.');
    if (existing.organization_id !== orgId) throw new NotFoundError('Role not found.');

    const { count } = await supabase
      .from('user_roles')
      .select('id', { count: 'exact', head: true })
      .eq('role_id', id);
    if (count && count > 0) {
      throw new ConflictError('This role is still assigned to one or more users.');
    }

    const { error } = await supabase.from('roles').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.ROLE_DELETED,
      entityType: 'role',
      entityId: id,
      oldValue: { name: existing.name },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });
}
