-- Phase 12: RLS policies for the 4 analytics rollup tables. Same
-- defense-in-depth pattern as every prior phase (Phase 11's
-- call_evaluations policies are the closest precedent): the backend does
-- its real reads with the service-role key and enforces org-scoping +
-- `analytics.view` explicitly in application code
-- (routes/dashboard.ts, routes/analytics.ts); these policies are the
-- second line of defense for any code path that ever queries with a
-- user's own JWT. Only the aggregator job (service-role) ever writes to
-- these tables, so insert/update policies just require organization_id
-- to match the caller's own org - no user-facing route mutates them.

drop policy if exists analytics_daily_org_select on public.analytics_daily_org;
create policy analytics_daily_org_select on public.analytics_daily_org
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('analytics.view')
  );

drop policy if exists analytics_daily_org_insert on public.analytics_daily_org;
create policy analytics_daily_org_insert on public.analytics_daily_org
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists analytics_daily_org_update on public.analytics_daily_org;
create policy analytics_daily_org_update on public.analytics_daily_org
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

drop policy if exists analytics_daily_campaign_select on public.analytics_daily_campaign;
create policy analytics_daily_campaign_select on public.analytics_daily_campaign
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('analytics.view')
  );

drop policy if exists analytics_daily_campaign_insert on public.analytics_daily_campaign;
create policy analytics_daily_campaign_insert on public.analytics_daily_campaign
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists analytics_daily_campaign_update on public.analytics_daily_campaign;
create policy analytics_daily_campaign_update on public.analytics_daily_campaign
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

drop policy if exists analytics_daily_agent_select on public.analytics_daily_agent;
create policy analytics_daily_agent_select on public.analytics_daily_agent
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('analytics.view')
  );

drop policy if exists analytics_daily_agent_insert on public.analytics_daily_agent;
create policy analytics_daily_agent_insert on public.analytics_daily_agent
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists analytics_daily_agent_update on public.analytics_daily_agent;
create policy analytics_daily_agent_update on public.analytics_daily_agent
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

drop policy if exists analytics_hourly_org_select on public.analytics_hourly_org;
create policy analytics_hourly_org_select on public.analytics_hourly_org
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('analytics.view')
  );

drop policy if exists analytics_hourly_org_insert on public.analytics_hourly_org;
create policy analytics_hourly_org_insert on public.analytics_hourly_org
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists analytics_hourly_org_update on public.analytics_hourly_org;
create policy analytics_hourly_org_update on public.analytics_hourly_org
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());
