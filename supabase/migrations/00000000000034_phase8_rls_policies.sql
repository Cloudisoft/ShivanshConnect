-- Phase 8: Row Level Security policies for dispositions, call_dispositions,
-- callbacks. Same defense-in-depth approach as every prior phase: the
-- backend does its real reads/writes with the service-role key and
-- enforces org-scoping + the relevant permission explicitly in application
-- code (routes/dispositions.ts, routes/callbacks.ts, routes/calls.ts) -
-- these policies are the second line of defense for any code path that
-- ever queries with a user's own JWT.

-- ---------------------------------------------------------------------
-- dispositions - a null organization_id row is a system default, visible
-- to every org (read-only in application code); a non-null row is a
-- custom disposition scoped to that org.
-- ---------------------------------------------------------------------
drop policy if exists dispositions_select on public.dispositions;
create policy dispositions_select on public.dispositions
  for select
  using (
    organization_id is null
    or (organization_id = public.current_user_organization_id() and public.current_user_has_permission('campaigns.view'))
  );

drop policy if exists dispositions_insert on public.dispositions;
create policy dispositions_insert on public.dispositions
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  );

drop policy if exists dispositions_update on public.dispositions;
create policy dispositions_update on public.dispositions
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists dispositions_delete on public.dispositions;
create policy dispositions_delete on public.dispositions
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  );

-- ---------------------------------------------------------------------
-- call_dispositions
-- ---------------------------------------------------------------------
drop policy if exists call_dispositions_select on public.call_dispositions;
create policy call_dispositions_select on public.call_dispositions
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  );

drop policy if exists call_dispositions_insert on public.call_dispositions;
create policy call_dispositions_insert on public.call_dispositions
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists call_dispositions_update on public.call_dispositions;
create policy call_dispositions_update on public.call_dispositions
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- callbacks
-- ---------------------------------------------------------------------
drop policy if exists callbacks_select on public.callbacks;
create policy callbacks_select on public.callbacks
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('callbacks.manage')
  );

drop policy if exists callbacks_insert on public.callbacks;
create policy callbacks_insert on public.callbacks
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('callbacks.manage')
  );

drop policy if exists callbacks_update on public.callbacks;
create policy callbacks_update on public.callbacks
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('callbacks.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists callbacks_delete on public.callbacks;
create policy callbacks_delete on public.callbacks
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('callbacks.manage')
  );
