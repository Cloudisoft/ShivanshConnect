-- Phase 7: Row Level Security policies for campaigns, campaign_versions,
-- campaign_leads, campaign_lead_skip_log, campaign_settings,
-- dialing_settings.
--
-- Same approach as every prior phase: the backend does its real reads/
-- writes with the service-role key and enforces org-scoping + the
-- relevant permission explicitly in application code
-- (routes/campaigns.ts, services/campaignDispatcher.ts). These policies
-- are the second line of defense for any code path that ever queries with
-- a user's own JWT.

-- ---------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------
drop policy if exists campaigns_select on public.campaigns;
create policy campaigns_select on public.campaigns
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.view')
  );

drop policy if exists campaigns_insert on public.campaigns;
create policy campaigns_insert on public.campaigns
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.create')
  );

drop policy if exists campaigns_update on public.campaigns;
create policy campaigns_update on public.campaigns
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists campaigns_delete on public.campaigns;
create policy campaigns_delete on public.campaigns
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.delete')
  );

-- ---------------------------------------------------------------------
-- campaign_versions
-- ---------------------------------------------------------------------
drop policy if exists campaign_versions_select on public.campaign_versions;
create policy campaign_versions_select on public.campaign_versions
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.view')
  );

drop policy if exists campaign_versions_insert on public.campaign_versions;
create policy campaign_versions_insert on public.campaign_versions
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  );

drop policy if exists campaign_versions_update on public.campaign_versions;
create policy campaign_versions_update on public.campaign_versions
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- campaign_leads
-- ---------------------------------------------------------------------
drop policy if exists campaign_leads_select on public.campaign_leads;
create policy campaign_leads_select on public.campaign_leads
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.view')
  );

drop policy if exists campaign_leads_insert on public.campaign_leads;
create policy campaign_leads_insert on public.campaign_leads
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  );

drop policy if exists campaign_leads_update on public.campaign_leads;
create policy campaign_leads_update on public.campaign_leads
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- campaign_lead_skip_log - select only for the authenticated role; every
-- write comes from the backend's service-role key (the dispatcher).
-- ---------------------------------------------------------------------
drop policy if exists campaign_lead_skip_log_select on public.campaign_lead_skip_log;
create policy campaign_lead_skip_log_select on public.campaign_lead_skip_log
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.view')
  );

-- ---------------------------------------------------------------------
-- campaign_settings
-- ---------------------------------------------------------------------
drop policy if exists campaign_settings_select on public.campaign_settings;
create policy campaign_settings_select on public.campaign_settings
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.view')
  );

drop policy if exists campaign_settings_insert on public.campaign_settings;
create policy campaign_settings_insert on public.campaign_settings
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  );

drop policy if exists campaign_settings_update on public.campaign_settings;
create policy campaign_settings_update on public.campaign_settings
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- dialing_settings
-- ---------------------------------------------------------------------
drop policy if exists dialing_settings_select on public.dialing_settings;
create policy dialing_settings_select on public.dialing_settings
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.view')
  );

drop policy if exists dialing_settings_insert on public.dialing_settings;
create policy dialing_settings_insert on public.dialing_settings
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('settings.manage')
  );

drop policy if exists dialing_settings_update on public.dialing_settings;
create policy dialing_settings_update on public.dialing_settings
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('settings.manage')
  )
  with check (organization_id = public.current_user_organization_id());
