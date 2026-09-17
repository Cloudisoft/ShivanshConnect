-- Phase 4: Row Level Security policies for voice_providers,
-- voice_provider_credentials, voices.
--
-- Same approach as 00000000000008/16/22: the backend does its actual
-- reads/writes with the service-role key and enforces org-scoping + the
-- `voices.manage` permission explicitly in application code
-- (apps/backend/src/routes/voiceProviders.ts, voices.ts). These policies
-- are the second line of defense for any code path that ever queries
-- with a user's own JWT.

-- ---------------------------------------------------------------------
-- voice_providers - fixed platform catalog (organization_id is null for
-- all 4 seeded rows), readable by any authenticated user with
-- voices.manage. No insert/update/delete policy for the authenticated
-- role: the catalog is seeded by migration only.
-- ---------------------------------------------------------------------
drop policy if exists voice_providers_select on public.voice_providers;
create policy voice_providers_select on public.voice_providers
  for select
  using (public.current_user_has_permission('voices.manage'));

-- ---------------------------------------------------------------------
-- voice_provider_credentials
-- ---------------------------------------------------------------------
drop policy if exists voice_provider_credentials_select on public.voice_provider_credentials;
create policy voice_provider_credentials_select on public.voice_provider_credentials
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  );

drop policy if exists voice_provider_credentials_insert on public.voice_provider_credentials;
create policy voice_provider_credentials_insert on public.voice_provider_credentials
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  );

drop policy if exists voice_provider_credentials_update on public.voice_provider_credentials;
create policy voice_provider_credentials_update on public.voice_provider_credentials
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists voice_provider_credentials_delete on public.voice_provider_credentials;
create policy voice_provider_credentials_delete on public.voice_provider_credentials
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  );

-- ---------------------------------------------------------------------
-- voices
-- ---------------------------------------------------------------------
drop policy if exists voices_select on public.voices;
create policy voices_select on public.voices
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  );

drop policy if exists voices_insert on public.voices;
create policy voices_insert on public.voices
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  );

drop policy if exists voices_update on public.voices;
create policy voices_update on public.voices
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists voices_delete on public.voices;
create policy voices_delete on public.voices
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('voices.manage')
  );
