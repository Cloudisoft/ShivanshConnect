-- Phase 1: Row Level Security policies
--
-- Approach:
--   The backend API authenticates every request by verifying the caller's
--   Supabase JWT, then does its actual reads/writes using the Supabase
--   service role key (which bypasses RLS) so it can enforce
--   organization-scoping and permission checks explicitly in application
--   code (see apps/backend/src/middleware/auth.ts and
--   apps/backend/src/lib/tenant.ts). RLS here is the second line of
--   defense: if any code path ever queries Postgres using a user's own
--   JWT (the Supabase anon/authenticated role) instead of the service
--   role, these policies still guarantee the row can only touch data in
--   that user's own organization, and mutations still require the
--   relevant permission via public.current_user_has_permission().
--
--   public.current_user_organization_id() and
--   public.current_user_has_permission() (defined in earlier migrations)
--   both resolve from auth.uid(), which Postgres/PostgREST/Supabase sets
--   from the verified JWT `sub` claim - never from client input.

-- ---------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select
  using (id = public.current_user_organization_id());

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update
  using (id = public.current_user_organization_id() and public.current_user_has_permission('settings.manage'))
  with check (id = public.current_user_organization_id());

-- Organization creation (signup) is performed by the backend using the
-- service role key, which bypasses RLS entirely - intentionally no
-- authenticated-role insert policy exists here.

-- ---------------------------------------------------------------------
-- organization_settings
-- ---------------------------------------------------------------------
drop policy if exists organization_settings_select on public.organization_settings;
create policy organization_settings_select on public.organization_settings
  for select
  using (organization_id = public.current_user_organization_id());

drop policy if exists organization_settings_update on public.organization_settings;
create policy organization_settings_update on public.organization_settings
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('settings.manage')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select
  using (organization_id = public.current_user_organization_id());

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update
  using (id = auth.uid())
  with check (id = auth.uid() and organization_id = public.current_user_organization_id());

drop policy if exists users_update_managed on public.users;
create policy users_update_managed on public.users
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('users.manage')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------
drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles
  for select
  using (is_system_role or organization_id = public.current_user_organization_id());

drop policy if exists roles_insert on public.roles;
create policy roles_insert on public.roles
  for insert
  with check (
    not is_system_role
    and organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('roles.manage')
  );

drop policy if exists roles_update on public.roles;
create policy roles_update on public.roles
  for update
  using (
    not is_system_role
    and organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('roles.manage')
  )
  with check (not is_system_role and organization_id = public.current_user_organization_id());

drop policy if exists roles_delete on public.roles;
create policy roles_delete on public.roles
  for delete
  using (
    not is_system_role
    and organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('roles.manage')
  );

-- ---------------------------------------------------------------------
-- permissions (global read-only catalog)
-- ---------------------------------------------------------------------
drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions
  for select
  using (auth.uid() is not null);

-- ---------------------------------------------------------------------
-- role_permissions
-- ---------------------------------------------------------------------
drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions
  for select
  using (
    exists (
      select 1 from public.roles r
      where r.id = role_permissions.role_id
        and (r.is_system_role or r.organization_id = public.current_user_organization_id())
    )
  );

drop policy if exists role_permissions_insert on public.role_permissions;
create policy role_permissions_insert on public.role_permissions
  for insert
  with check (
    public.current_user_has_permission('roles.manage')
    and exists (
      select 1 from public.roles r
      where r.id = role_permissions.role_id
        and not r.is_system_role
        and r.organization_id = public.current_user_organization_id()
    )
  );

drop policy if exists role_permissions_delete on public.role_permissions;
create policy role_permissions_delete on public.role_permissions
  for delete
  using (
    public.current_user_has_permission('roles.manage')
    and exists (
      select 1 from public.roles r
      where r.id = role_permissions.role_id
        and not r.is_system_role
        and r.organization_id = public.current_user_organization_id()
    )
  );

-- ---------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------
drop policy if exists user_roles_select on public.user_roles;
create policy user_roles_select on public.user_roles
  for select
  using (organization_id = public.current_user_organization_id());

drop policy if exists user_roles_insert on public.user_roles;
create policy user_roles_insert on public.user_roles
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('users.manage')
  );

drop policy if exists user_roles_delete on public.user_roles;
create policy user_roles_delete on public.user_roles
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('users.manage')
  );

-- ---------------------------------------------------------------------
-- audit_logs (write-once from the app layer; readable with audit.view)
-- ---------------------------------------------------------------------
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('audit.view')
  );

drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs
  for insert
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- user_invitations
-- ---------------------------------------------------------------------
drop policy if exists user_invitations_select on public.user_invitations;
create policy user_invitations_select on public.user_invitations
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('users.manage')
  );

drop policy if exists user_invitations_insert on public.user_invitations;
create policy user_invitations_insert on public.user_invitations
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('users.manage')
  );

drop policy if exists user_invitations_update on public.user_invitations;
create policy user_invitations_update on public.user_invitations
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('users.manage')
  )
  with check (organization_id = public.current_user_organization_id());

-- Note: accepting an invitation happens unauthenticated (the invitee has no
-- session yet, only a token from the invite email) and is therefore only
-- ever performed by the backend using the service role key, never by a
-- client-side authenticated-role query.
