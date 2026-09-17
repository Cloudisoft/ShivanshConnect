import type { FastifyInstance } from 'fastify';
import {
  acceptInvitationSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  signupSchema,
} from '../schemas/auth.js';
import { getSupabaseAdmin, getSupabaseAnon } from '../lib/supabase.js';
import { generateUniqueOrgSlug } from '../lib/slug.js';
import { getEnv } from '../env.js';
import { ok } from '../lib/response.js';
import { AppError, ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { authenticate } from '../middleware/auth.js';
import { writeAuditLog } from '../lib/audit.js';

const AUTH_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
    },
  },
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------
  // POST /api/v1/auth/signup
  // ---------------------------------------------------------------
  app.post('/signup', AUTH_RATE_LIMIT, async (req, reply) => {
    const body = signupSchema.parse(req.body);
    const supabaseAdmin = getSupabaseAdmin();
    const supabaseAnon = getSupabaseAnon();

    // 1. Create the Supabase Auth user via the anon-key signUp flow so
    //    Supabase's built-in email verification is triggered.
    const { data: signUpData, error: signUpError } = await supabaseAnon.auth.signUp({
      email: body.email,
      password: body.password,
      options: {
        data: { full_name: body.full_name },
        emailRedirectTo: `${getEnv().FRONTEND_URL}/verify-email`,
      },
    });

    if (signUpError || !signUpData.user) {
      if (signUpError?.message?.toLowerCase().includes('already registered')) {
        throw new ConflictError('An account with this email already exists.');
      }
      throw new AppError(400, 'SIGNUP_FAILED', signUpError?.message ?? 'Could not create account.');
    }

    const authUserId = signUpData.user.id;

    try {
      // 2. Create the organization + settings row.
      const slug = await generateUniqueOrgSlug(supabaseAdmin, body.organization_name);
      const { data: org, error: orgError } = await supabaseAdmin
        .from('organizations')
        .insert({ name: body.organization_name, slug, timezone: body.timezone })
        .select('id, name, slug, timezone, status, created_at, updated_at')
        .single();
      if (orgError || !org) throw orgError ?? new Error('Organization creation failed');

      const { error: settingsError } = await supabaseAdmin
        .from('organization_settings')
        .insert({ organization_id: org.id, settings: {} });
      if (settingsError) throw settingsError;

      // 3. Create the public.users row for this auth user.
      const { data: userRow, error: userError } = await supabaseAdmin
        .from('users')
        .insert({
          id: authUserId,
          organization_id: org.id,
          email: body.email,
          full_name: body.full_name,
          status: 'active',
        })
        .select('id, organization_id, email, full_name, avatar_url, status, created_at, updated_at')
        .single();
      if (userError || !userRow) throw userError ?? new Error('User creation failed');

      // 4. Assign the SUPER_ADMIN system role - the account creator owns
      //    the organization.
      const { data: superAdminRole, error: roleError } = await supabaseAdmin
        .from('roles')
        .select('id')
        .eq('is_system_role', true)
        .eq('name', 'SUPER_ADMIN')
        .single();
      if (roleError || !superAdminRole) throw roleError ?? new Error('SUPER_ADMIN role missing');

      const { error: userRoleError } = await supabaseAdmin
        .from('user_roles')
        .insert({ user_id: authUserId, role_id: superAdminRole.id, organization_id: org.id });
      if (userRoleError) throw userRoleError;

      return reply.status(201).send(
        ok(
          {
            organization: org,
            user: userRow,
            session: signUpData.session ?? null,
            email_confirmation_required: !signUpData.session,
          },
          {
            message: signUpData.session
              ? 'Account created.'
              : 'Account created. Check your email to verify your address before signing in.',
          },
        ),
      );
    } catch (err) {
      // Roll back the orphaned auth user if org/user provisioning failed,
      // so a retry with the same email doesn't hit "already registered".
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => undefined);
      throw err;
    }
  });

  // ---------------------------------------------------------------
  // POST /api/v1/auth/login
  // ---------------------------------------------------------------
  app.post('/login', AUTH_RATE_LIMIT, async (req) => {
    const body = loginSchema.parse(req.body);
    const supabaseAnon = getSupabaseAnon();

    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    if (error || !data.session) {
      throw new UnauthorizedError('Incorrect email or password.');
    }

    return ok({ session: data.session, user: data.user });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/auth/logout
  // ---------------------------------------------------------------
  app.post('/logout', { preHandler: authenticate }, async (req) => {
    const authHeader = req.headers.authorization!;
    const token = authHeader.slice('Bearer '.length).trim();
    const supabaseAdmin = getSupabaseAdmin();
    await supabaseAdmin.auth.admin.signOut(token, 'global').catch(() => undefined);
    return ok({ signed_out: true });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/auth/password-reset/request
  // ---------------------------------------------------------------
  app.post('/password-reset/request', AUTH_RATE_LIMIT, async (req) => {
    const body = passwordResetRequestSchema.parse(req.body);
    const supabaseAnon = getSupabaseAnon();
    await supabaseAnon.auth.resetPasswordForEmail(body.email, {
      redirectTo: `${getEnv().FRONTEND_URL}/reset-password`,
    });
    // Always respond success regardless of whether the email exists, to
    // avoid leaking which addresses have accounts.
    return ok({ requested: true }, { message: 'If that email exists, a reset link has been sent.' });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/auth/password-reset/confirm
  // ---------------------------------------------------------------
  app.post('/password-reset/confirm', AUTH_RATE_LIMIT, async (req) => {
    const body = passwordResetConfirmSchema.parse(req.body);
    const supabaseAnon = getSupabaseAnon();

    const { error: sessionError } = await supabaseAnon.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
    });
    if (sessionError) {
      throw new ValidationError('Reset link is invalid or has expired. Request a new one.');
    }

    const { error: updateError } = await supabaseAnon.auth.updateUser({
      password: body.new_password,
    });
    if (updateError) {
      throw new AppError(400, 'PASSWORD_RESET_FAILED', updateError.message);
    }

    return ok({ reset: true }, { message: 'Your password has been updated.' });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/auth/accept-invitation
  // ---------------------------------------------------------------
  app.post('/accept-invitation', AUTH_RATE_LIMIT, async (req) => {
    const body = acceptInvitationSchema.parse(req.body);
    const supabaseAdmin = getSupabaseAdmin();
    const supabaseAnon = getSupabaseAnon();

    const { data: invitation, error: inviteError } = await supabaseAdmin
      .from('user_invitations')
      .select('id, organization_id, email, role_id, status, expires_at')
      .eq('token', body.token)
      .maybeSingle();

    if (inviteError) throw inviteError;
    if (!invitation) throw new NotFoundError('This invitation link is invalid.');
    if (invitation.status !== 'pending') {
      throw new ConflictError('This invitation has already been used or revoked.');
    }
    if (new Date(invitation.expires_at).getTime() < Date.now()) {
      await supabaseAdmin.from('user_invitations').update({ status: 'expired' }).eq('id', invitation.id);
      throw new ConflictError('This invitation has expired. Ask an admin to resend it.');
    }

    const { data: createdUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: invitation.email,
      password: body.password,
      email_confirm: true,
      user_metadata: { full_name: body.full_name },
    });
    if (createError || !createdUser.user) {
      if (createError?.message?.toLowerCase().includes('already registered')) {
        throw new ConflictError('An account with this email already exists. Try logging in instead.');
      }
      throw new AppError(400, 'ACCEPT_INVITATION_FAILED', createError?.message ?? 'Could not create account.');
    }

    const authUserId = createdUser.user.id;

    const { error: userError } = await supabaseAdmin.from('users').insert({
      id: authUserId,
      organization_id: invitation.organization_id,
      email: invitation.email,
      full_name: body.full_name,
      status: 'active',
    });
    if (userError) {
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => undefined);
      throw userError;
    }

    const { error: userRoleError } = await supabaseAdmin.from('user_roles').insert({
      user_id: authUserId,
      role_id: invitation.role_id,
      organization_id: invitation.organization_id,
    });
    if (userRoleError) throw userRoleError;

    await supabaseAdmin
      .from('user_invitations')
      .update({ status: 'accepted' })
      .eq('id', invitation.id);

    await writeAuditLog({
      organizationId: invitation.organization_id,
      userId: authUserId,
      action: 'user.invitation_accepted',
      entityType: 'user',
      entityId: authUserId,
      newValue: { email: invitation.email, role_id: invitation.role_id },
      ipAddress: req.ip,
    });

    const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
      email: invitation.email,
      password: body.password,
    });
    if (signInError || !signInData.session) {
      // Account was created successfully; sign-in failing is unexpected
      // but not fatal - the person can log in normally.
      return ok(
        { account_created: true, session: null },
        { message: 'Account created. Please sign in.' },
      );
    }

    return ok({ account_created: true, session: signInData.session, user: signInData.user });
  });
}
