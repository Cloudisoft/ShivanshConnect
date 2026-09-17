-- Phase 2: Row Level Security policies for lead_lists, leads,
-- lead_list_members, lead_custom_fields, dnc_entries, import_jobs and
-- import_job_rows.
--
-- Same approach as 00000000000008_rls_policies.sql: the backend does its
-- actual reads/writes with the service-role key and enforces
-- organization-scoping + permissions explicitly in application code
-- (apps/backend/src/routes/*). These policies are the second line of
-- defense for any code path that ever queries with a user's own JWT.

-- ---------------------------------------------------------------------
-- lead_lists
-- ---------------------------------------------------------------------
drop policy if exists lead_lists_select on public.lead_lists;
create policy lead_lists_select on public.lead_lists
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.view')
  );

drop policy if exists lead_lists_insert on public.lead_lists;
create policy lead_lists_insert on public.lead_lists
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.create')
  );

drop policy if exists lead_lists_update on public.lead_lists;
create policy lead_lists_update on public.lead_lists
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.edit')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists lead_lists_delete on public.lead_lists;
create policy lead_lists_delete on public.lead_lists
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.delete')
  );

-- ---------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.view')
  );

drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and (
      public.current_user_has_permission('leads.create')
      or public.current_user_has_permission('leads.import')
    )
  );

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.edit')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.delete')
  );

-- ---------------------------------------------------------------------
-- lead_list_members
-- ---------------------------------------------------------------------
drop policy if exists lead_list_members_select on public.lead_list_members;
create policy lead_list_members_select on public.lead_list_members
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.view')
  );

drop policy if exists lead_list_members_insert on public.lead_list_members;
create policy lead_list_members_insert on public.lead_list_members
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and (
      public.current_user_has_permission('leads.create')
      or public.current_user_has_permission('leads.import')
      or public.current_user_has_permission('leads.edit')
    )
  );

drop policy if exists lead_list_members_delete on public.lead_list_members;
create policy lead_list_members_delete on public.lead_list_members
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.edit')
  );

-- ---------------------------------------------------------------------
-- lead_custom_fields
-- ---------------------------------------------------------------------
drop policy if exists lead_custom_fields_select on public.lead_custom_fields;
create policy lead_custom_fields_select on public.lead_custom_fields
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.view')
  );

drop policy if exists lead_custom_fields_insert on public.lead_custom_fields;
create policy lead_custom_fields_insert on public.lead_custom_fields
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.edit')
  );

drop policy if exists lead_custom_fields_delete on public.lead_custom_fields;
create policy lead_custom_fields_delete on public.lead_custom_fields
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.edit')
  );

-- ---------------------------------------------------------------------
-- dnc_entries (global rows, organization_id is null, are readable by any
-- authenticated user but never writable through the authenticated role -
-- only the backend's service-role key manages global entries)
-- ---------------------------------------------------------------------
drop policy if exists dnc_entries_select on public.dnc_entries;
create policy dnc_entries_select on public.dnc_entries
  for select
  using (
    organization_id is null
    or (
      organization_id = public.current_user_organization_id()
      and public.current_user_has_permission('leads.view')
    )
  );

drop policy if exists dnc_entries_insert on public.dnc_entries;
create policy dnc_entries_insert on public.dnc_entries
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.edit')
  );

drop policy if exists dnc_entries_delete on public.dnc_entries;
create policy dnc_entries_delete on public.dnc_entries
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.edit')
  );

-- ---------------------------------------------------------------------
-- import_jobs
-- ---------------------------------------------------------------------
drop policy if exists import_jobs_select on public.import_jobs;
create policy import_jobs_select on public.import_jobs
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.import')
  );

drop policy if exists import_jobs_insert on public.import_jobs;
create policy import_jobs_insert on public.import_jobs
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.import')
  );

drop policy if exists import_jobs_update on public.import_jobs;
create policy import_jobs_update on public.import_jobs
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.import')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- import_job_rows
-- ---------------------------------------------------------------------
drop policy if exists import_job_rows_select on public.import_job_rows;
create policy import_job_rows_select on public.import_job_rows
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.import')
  );

drop policy if exists import_job_rows_insert on public.import_job_rows;
create policy import_job_rows_insert on public.import_job_rows
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.import')
  );

drop policy if exists import_job_rows_update on public.import_job_rows;
create policy import_job_rows_update on public.import_job_rows
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('leads.import')
  )
  with check (organization_id = public.current_user_organization_id());
