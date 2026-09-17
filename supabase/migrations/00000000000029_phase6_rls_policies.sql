-- Phase 6: Row Level Security policies for vapi_credentials, calls,
-- call_events, webhook_events, webhook_failures.
--
-- Same approach as every prior phase's *_rls_policies.sql: the backend
-- does its actual reads/writes with the service-role key and enforces
-- org-scoping + the relevant permission explicitly in application code
-- (routes/vapi.ts, routes/calls.ts, routes/webhooks.ts). These policies
-- are the second line of defense for any code path that ever queries with
-- a user's own JWT.
--
-- webhook_events/webhook_failures have no policy granting the
-- `authenticated` role insert/update rights at all - only the backend's
-- service-role key (which bypasses RLS entirely) ever writes to them, from
-- the unauthenticated webhook receivers in routes/webhooks.ts. Select is
-- still policy-gated for the admin log view (GET /webhook-events).

-- ---------------------------------------------------------------------
-- vapi_credentials
-- ---------------------------------------------------------------------
drop policy if exists vapi_credentials_select on public.vapi_credentials;
create policy vapi_credentials_select on public.vapi_credentials
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists vapi_credentials_insert on public.vapi_credentials;
create policy vapi_credentials_insert on public.vapi_credentials
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists vapi_credentials_update on public.vapi_credentials;
create policy vapi_credentials_update on public.vapi_credentials
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- calls
-- ---------------------------------------------------------------------
drop policy if exists calls_select on public.calls;
create policy calls_select on public.calls
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  );

drop policy if exists calls_insert on public.calls;
create policy calls_insert on public.calls
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  );

drop policy if exists calls_update on public.calls;
create policy calls_update on public.calls
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- call_events
-- ---------------------------------------------------------------------
drop policy if exists call_events_select on public.call_events;
create policy call_events_select on public.call_events
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  );

drop policy if exists call_events_insert on public.call_events;
create policy call_events_insert on public.call_events
  for insert
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- webhook_events - select only for the authenticated role (admin log
-- view); every write comes from the backend's service-role key.
-- ---------------------------------------------------------------------
drop policy if exists webhook_events_select on public.webhook_events;
create policy webhook_events_select on public.webhook_events
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('webhooks.manage')
  );

-- ---------------------------------------------------------------------
-- webhook_failures - select only, scoped through its parent webhook_event.
-- ---------------------------------------------------------------------
drop policy if exists webhook_failures_select on public.webhook_failures;
create policy webhook_failures_select on public.webhook_failures
  for select
  using (
    exists (
      select 1 from public.webhook_events we
      where we.id = webhook_failures.webhook_event_id
        and we.organization_id = public.current_user_organization_id()
    )
    and public.current_user_has_permission('webhooks.manage')
  );
