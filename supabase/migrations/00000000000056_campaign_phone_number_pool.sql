-- Feature: campaigns could only ever dial out from ONE phone number
-- (campaigns.phone_number_id, a single FK) - no way to rotate across
-- several numbers, whether from the same provider or mixed Twilio/
-- Telnyx. This adds a real many-to-many pool: a campaign attaches any
-- number of phone_numbers rows (any mix of providers - a number's
-- provider is resolved independently per call, so mixing has never been
-- a problem, only the lack of a multi-select ever was), and the
-- dispatcher round-robins across the pool per call.
--
-- campaigns.phone_number_id is intentionally left in place (existing
-- single-number campaigns keep working via the dispatcher's fallback)
-- and backfilled into the new pool below so every campaign that already
-- had a number keeps dialing from it with zero behavior change until an
-- org explicitly adds more numbers.
create table if not exists public.campaign_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  phone_number_id uuid not null references public.phone_numbers (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint campaign_phone_numbers_unique unique (campaign_id, phone_number_id)
);

create index if not exists campaign_phone_numbers_campaign_id_idx on public.campaign_phone_numbers (campaign_id);
create index if not exists campaign_phone_numbers_phone_number_id_idx on public.campaign_phone_numbers (phone_number_id);

alter table public.campaign_phone_numbers enable row level security;

-- Second line of defense for any code path that ever queries with a
-- user's own JWT rather than the service-role key the backend actually
-- uses (same approach as every other org-scoped table's RLS policies).
drop policy if exists campaign_phone_numbers_select on public.campaign_phone_numbers;
create policy campaign_phone_numbers_select on public.campaign_phone_numbers
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.view')
  );

drop policy if exists campaign_phone_numbers_write on public.campaign_phone_numbers;
create policy campaign_phone_numbers_write on public.campaign_phone_numbers
  for all
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  )
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('campaigns.edit')
  );

insert into public.campaign_phone_numbers (campaign_id, phone_number_id, organization_id)
select id, phone_number_id, organization_id
from public.campaigns
where phone_number_id is not null
on conflict (campaign_id, phone_number_id) do nothing;
