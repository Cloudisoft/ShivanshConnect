import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { inviteUserSchema, listUsersQuerySchema, updateUserSchema } from '../schemas/users.js';
import { invalidateUserContext } from '../lib/permissions.js';
import { uuidSchema } from '../schemas/common.js';
import { writeAuditLog } from '../lib/audit.js';
import { getEmailService } from '../lib/email.js';
import { getEnv } from '../env.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // ---------------------------------------------------------------
  // GET /api/v1/users - paginated list of org users
  // ---------------------------------------------------------------
  app.get('/', { preHandler: requirePermission('users.manage') }, async (req) => {
    const query = listUsersQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase
      .from('users')
      .select(
        'id, organization_id, email, full_name, avatar_url, status, created_at, updated_at, user_roles(role_id, roles(id, name, is_system_role))',
        { count: 'exact' },
      )
      .eq('organization_id', orgId);

    if (query.status) builder = builder.eq('status', query.status);
    if (query.search) builder = builder.ilike('full_name', `%${query.search}%`);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;

    const users = (data ?? []).map((u: any) => ({
      id: u.id,
      organization_id: u.organization_id,
      email: u.email,
      full_name: u.full_name,
      avatar_url: u.avatar_url,
      status: u.status,
      created_at: u.created_at,
      updated_at: u.updated_at,
      roles: (u.user_roles ?? [])
        .map((ur: any) => ur.roles)
        .filter(Boolean)
        .map((r: any) => ({ id: r.id, name: r.name, is_system_role: r.is_system_role })),
    }));

    return ok(users, { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // ---------------------------------------------------------------
  // GET /api/v1/users/invitations - pending invitations for the org
  // ---------------------------------------------------------------
  app.get('/invitations', { preHandler: requirePermission('users.manage') }, async (req) => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('user_invitations')
      .select('id, organization_id, email, role_id, invited_by, status, expires_at, created_at, roles(name)')
      .eq('organization_id', req.user!.organizationId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return ok(
      (data ?? []).map((i: any) => ({ ...i, role_name: i.roles?.name ?? null, roles: undefined })),
    );
  });

  // ---------------------------------------------------------------
  // POST /api/v1/users - invite a new user
  // ---------------------------------------------------------------
  app.post('/', { preHandler: requirePermission('users.manage') }, async (req, reply) => {
    const body = inviteUserSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('id, organization_id, is_system_role, name')
      .eq('id', body.role_id)
      .maybeSingle();
    if (roleError) throw roleError;
    if (!role || (!role.is_system_role && role.organization_id !== orgId)) {
      throw new ValidationError('That role does not exist for your organization.');
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', body.email)
      .maybeSingle();
    if (existingUser) {
      throw new ConflictError('A user with this email already exists.');
    }

    const { data: existingInvite } = await supabase
      .from('user_invitations')
      .select('id')
      .eq('organization_id', orgId)
      .eq('email', body.email)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingInvite) {
      throw new ConflictError('An invitation is already pending for this email.');
    }

    const token = randomUUID();
    const { data: invitation, error: inviteError } = await supabase
      .from('user_invitations')
      .insert({
        organization_id: orgId,
        email: body.email,
        role_id: body.role_id,
        invited_by: req.user!.id,
        token,
      })
      .select('id, organization_id, email, role_id, invited_by, status, expires_at, created_at')
      .single();
    if (inviteError || !invitation) throw inviteError ?? new Error('Invitation creation failed');

    const { data: org } = await supabase.from('organizations').select('name').eq('id', orgId).single();
    const inviteUrl = `${getEnv().FRONTEND_URL}/accept-invitation?token=${token}`;

    await getEmailService().sendInvitationEmail({
      to: body.email,
      organizationName: org?.name ?? 'your organization',
      inviteUrl,
      invitedByName: req.user!.fullName || req.user!.email,
    });

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.USER_INVITED,
      entityType: 'user_invitation',
      entityId: invitation.id,
      newValue: { email: body.email, role_id: body.role_id },
      ipAddress: req.ip,
    });

    return reply
      .status(201)
      .send(ok({ invitation, invite_url: inviteUrl }, { message: 'Invitation sent.' }));
  });

  // ---------------------------------------------------------------
  // DELETE /api/v1/users/invitations/:id - revoke a pending invitation
  // ---------------------------------------------------------------
  app.delete(
    '/invitations/:id',
    { preHandler: requirePermission('users.manage') },
    async (req) => {
      const { id } = req.params as { id: string };
      uuidSchema.parse(id);
      const supabase = getSupabaseAdmin();

      const { data: invitation, error } = await supabase
        .from('user_invitations')
        .select('id, organization_id, status')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!invitation) throw new NotFoundError('Invitation not found.');
      if (invitation.organization_id !== req.user!.organizationId) {
        throw new ForbiddenError();
      }

      const { error: updateError } = await supabase
        .from('user_invitations')
        .update({ status: 'revoked' })
        .eq('id', id);
      if (updateError) throw updateError;

      await writeAuditLog({
        organizationId: req.user!.organizationId,
        userId: req.user!.id,
        action: AUDIT_ACTIONS.USER_INVITATION_REVOKED,
        entityType: 'user_invitation',
        entityId: id,
        ipAddress: req.ip,
      });

      return ok({ revoked: true });
    },
  );

  // ---------------------------------------------------------------
  // PATCH /api/v1/users/:id - edit profile, change role, (de)activate
  // ---------------------------------------------------------------
  app.patch('/:id', { preHandler: requirePermission('users.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateUserSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: target, error: targetError } = await supabase
      .from('users')
      .select('id, organization_id, email, full_name, avatar_url, status')
      .eq('id', id)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target) throw new NotFoundError('User not found.');
    // Defense in depth: explicit org check even though the query above
    // could be extended with .eq('organization_id', orgId) - both layers
    // are kept so a query change elsewhere can't silently drop this.
    if (target.organization_id !== orgId) {
      throw new NotFoundError('User not found.');
    }

    const patch: Record<string, unknown> = {};
    if (body.full_name !== undefined) patch.full_name = body.full_name;
    if (body.avatar_url !== undefined) patch.avatar_url = body.avatar_url;
    if (body.status !== undefined) patch.status = body.status;

    if (Object.keys(patch).length > 0) {
      const { error: updateError } = await supabase.from('users').update(patch).eq('id', id);
      if (updateError) throw updateError;
      // A status/role change (deactivation in particular) must take effect
      // immediately, not after the cache's TTL.
      invalidateUserContext(id);
    }

    if (body.status !== undefined && body.status !== target.status) {
      await writeAuditLog({
        organizationId: orgId,
        userId: req.user!.id,
        action: body.status === 'inactive' ? AUDIT_ACTIONS.USER_DEACTIVATED : AUDIT_ACTIONS.USER_REACTIVATED,
        entityType: 'user',
        entityId: id,
        oldValue: { status: target.status },
        newValue: { status: body.status },
        ipAddress: req.ip,
      });
    } else if (Object.keys(patch).length > 0) {
      await writeAuditLog({
        organizationId: orgId,
        userId: req.user!.id,
        action: AUDIT_ACTIONS.USER_UPDATED,
        entityType: 'user',
        entityId: id,
        oldValue: target,
        newValue: patch,
        ipAddress: req.ip,
      });
    }

    if (body.role_id !== undefined) {
      const { data: role, error: roleError } = await supabase
        .from('roles')
        .select('id, organization_id, is_system_role')
        .eq('id', body.role_id)
        .maybeSingle();
      if (roleError) throw roleError;
      if (!role || (!role.is_system_role && role.organization_id !== orgId)) {
        throw new ValidationError('That role does not exist for your organization.');
      }

      const { data: previousRoles } = await supabase
        .from('user_roles')
        .select('role_id')
        .eq('user_id', id)
        .eq('organization_id', orgId);

      await supabase.from('user_roles').delete().eq('user_id', id).eq('organization_id', orgId);
      const { error: assignError } = await supabase
        .from('user_roles')
        .insert({ user_id: id, role_id: body.role_id, organization_id: orgId });
      if (assignError) throw assignError;
      invalidateUserContext(id);

      await writeAuditLog({
        organizationId: orgId,
        userId: req.user!.id,
        action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
        entityType: 'user',
        entityId: id,
        oldValue: { role_ids: (previousRoles ?? []).map((r) => r.role_id) },
        newValue: { role_id: body.role_id },
        ipAddress: req.ip,
      });
    }

    const { data: updated, error: fetchError } = await supabase
      .from('users')
      .select(
        'id, organization_id, email, full_name, avatar_url, status, created_at, updated_at, user_roles(roles(id, name, is_system_role))',
      )
      .eq('id', id)
      .single();
    if (fetchError || !updated) throw fetchError ?? new Error('User not found after update');

    return ok({
      ...updated,
      roles: (updated as any).user_roles?.map((ur: any) => ur.roles).filter(Boolean) ?? [],
      user_roles: undefined,
    });
  });
}
