-- Phase 13: Row Level Security policies for smtp_settings, sms_campaigns,
-- sms_messages, email_campaigns, email_messages, email_suppressions.
--
-- Same approach as every prior phase: the backend does its real reads/
-- writes with the service-role key and enforces org-scoping + the
-- `messaging.manage` / `settings.manage` permission explicitly in
-- application code (routes/smtp.ts, routes/smsCampaigns.ts,
-- routes/emailCampaigns.ts). These policies are the second line of
-- defense for any code path that ever queries with a user's own JWT.

-- ---------------------------------------------------------------------
-- smtp_settings - settings.manage (same permission gate Phase 1's
-- organization settings use).
-- ---------------------------------------------------------------------
drop policy if exists smtp_settings_select on public.smtp_settings;
create policy smtp_settings_select on public.smtp_settings
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('settings.manage')
  );

drop policy if exists smtp_settings_insert on public.smtp_settings;
create policy smtp_settings_insert on public.smtp_settings
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('settings.manage')
  );

drop policy if exists smtp_settings_update on public.smtp_settings;
create policy smtp_settings_update on public.smtp_settings
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('settings.manage')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- sms_campaigns / sms_messages - messaging.manage.
-- ---------------------------------------------------------------------
drop policy if exists sms_campaigns_select on public.sms_campaigns;
create policy sms_campaigns_select on public.sms_campaigns
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists sms_campaigns_insert on public.sms_campaigns;
create policy sms_campaigns_insert on public.sms_campaigns
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists sms_campaigns_update on public.sms_campaigns;
create policy sms_campaigns_update on public.sms_campaigns
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists sms_campaigns_delete on public.sms_campaigns;
create policy sms_campaigns_delete on public.sms_campaigns
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists sms_messages_select on public.sms_messages;
create policy sms_messages_select on public.sms_messages
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists sms_messages_insert on public.sms_messages;
create policy sms_messages_insert on public.sms_messages
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists sms_messages_update on public.sms_messages;
create policy sms_messages_update on public.sms_messages
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- email_campaigns / email_messages - messaging.manage.
-- ---------------------------------------------------------------------
drop policy if exists email_campaigns_select on public.email_campaigns;
create policy email_campaigns_select on public.email_campaigns
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists email_campaigns_insert on public.email_campaigns;
create policy email_campaigns_insert on public.email_campaigns
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists email_campaigns_update on public.email_campaigns;
create policy email_campaigns_update on public.email_campaigns
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists email_campaigns_delete on public.email_campaigns;
create policy email_campaigns_delete on public.email_campaigns
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select on public.email_messages
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('messaging.manage')
  );

drop policy if exists email_messages_insert on public.email_messages;
create policy email_messages_insert on public.email_messages
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists email_messages_update on public.email_messages;
create policy email_messages_update on public.email_messages
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- email_suppressions - same shape as dnc_entries: a null organization_id
-- row is a GLOBAL suppression, visible for matching to every org, but
-- only messaging.manage holders can list/add/remove.
-- ---------------------------------------------------------------------
drop policy if exists email_suppressions_select on public.email_suppressions;
create policy email_suppressions_select on public.email_suppressions
  for select
  using (
    public.current_user_has_permission('messaging.manage')
    and (organization_id is null or organization_id = public.current_user_organization_id())
  );

drop policy if exists email_suppressions_insert on public.email_suppressions;
create policy email_suppressions_insert on public.email_suppressions
  for insert
  with check (
    public.current_user_has_permission('messaging.manage')
    and (organization_id is null or organization_id = public.current_user_organization_id())
  );

drop policy if exists email_suppressions_delete on public.email_suppressions;
create policy email_suppressions_delete on public.email_suppressions
  for delete
  using (
    public.current_user_has_permission('messaging.manage')
    and (organization_id is null or organization_id = public.current_user_organization_id())
  );
