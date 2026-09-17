-- Phase 5: Row Level Security policies for phone_number_providers,
-- phone_number_provider_credentials, phone_numbers.
--
-- Same approach as 00000000000008/16/22/25: the backend does its actual
-- reads/writes with the service-role key and enforces org-scoping + the
-- `numbers.manage` permission explicitly in application code
-- (apps/backend/src/routes/phoneNumberProviders.ts, phoneNumbers.ts).
-- These policies are the second line of defense for any code path that
-- ever queries with a user's own JWT.

-- ---------------------------------------------------------------------
-- phone_number_providers - fixed platform catalog, readable by any
-- authenticated user with numbers.manage. No insert/update/delete policy
-- for the authenticated role: the catalog is seeded by migration only.
-- ---------------------------------------------------------------------
drop policy if exists phone_number_providers_select on public.phone_number_providers;
create policy phone_number_providers_select on public.phone_number_providers
  for select
  using (public.current_user_has_permission('numbers.manage'));

-- ---------------------------------------------------------------------
-- phone_number_provider_credentials
-- ---------------------------------------------------------------------
drop policy if exists phone_number_provider_credentials_select on public.phone_number_provider_credentials;
create policy phone_number_provider_credentials_select on public.phone_number_provider_credentials
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  );

drop policy if exists phone_number_provider_credentials_insert on public.phone_number_provider_credentials;
create policy phone_number_provider_credentials_insert on public.phone_number_provider_credentials
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  );

drop policy if exists phone_number_provider_credentials_update on public.phone_number_provider_credentials;
create policy phone_number_provider_credentials_update on public.phone_number_provider_credentials
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists phone_number_provider_credentials_delete on public.phone_number_provider_credentials;
create policy phone_number_provider_credentials_delete on public.phone_number_provider_credentials
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  );

-- ---------------------------------------------------------------------
-- phone_numbers
-- ---------------------------------------------------------------------
drop policy if exists phone_numbers_select on public.phone_numbers;
create policy phone_numbers_select on public.phone_numbers
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  );

drop policy if exists phone_numbers_insert on public.phone_numbers;
create policy phone_numbers_insert on public.phone_numbers
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  );

drop policy if exists phone_numbers_update on public.phone_numbers;
create policy phone_numbers_update on public.phone_numbers
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists phone_numbers_delete on public.phone_numbers;
create policy phone_numbers_delete on public.phone_numbers
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('numbers.manage')
  );
