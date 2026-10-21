-- Additive, opt-in organization-wide caller-ID pool.
-- Existing calls are unchanged unless settings.caller_id_routing_enabled
-- is explicitly set to true and numbers are added to caller_id_pool.
create table if not exists public.caller_id_pool (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone_number_id uuid not null references public.phone_numbers(id) on delete cascade,
  enabled boolean not null default true,
  last_selected_at timestamptz not null default 'epoch'::timestamptz,
  selection_count bigint not null default 0 check (selection_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caller_id_pool_org_number_unique unique (organization_id, phone_number_id)
);

create index if not exists caller_id_pool_org_enabled_idx
  on public.caller_id_pool (organization_id, enabled, last_selected_at);

-- Seed the pool from existing active outbound-capable numbers. This is
-- storage-only: routing remains disabled unless the org opts in.
insert into public.caller_id_pool (organization_id, phone_number_id)
select organization_id, id
from public.phone_numbers
where status = 'active'
  and coalesce((capabilities ->> 'voice_outbound')::boolean, false) = true
on conflict (organization_id, phone_number_id) do nothing;

-- Keep the pool in sync for numbers added later. Inactive/deleted numbers
-- are filtered at selection time; this trigger only adds newly eligible rows.
create or replace function public.add_eligible_phone_number_to_caller_id_pool()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active'
     and coalesce((new.capabilities ->> 'voice_outbound')::boolean, false) = true then
    insert into public.caller_id_pool (organization_id, phone_number_id)
    values (new.organization_id, new.id)
    on conflict (organization_id, phone_number_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists phone_numbers_add_to_caller_id_pool on public.phone_numbers;
create trigger phone_numbers_add_to_caller_id_pool
  after insert or update of status, capabilities on public.phone_numbers
  for each row execute function public.add_eligible_phone_number_to_caller_id_pool();

drop trigger if exists caller_id_pool_set_updated_at on public.caller_id_pool;
create trigger caller_id_pool_set_updated_at
  before update on public.caller_id_pool
  for each row execute function public.set_updated_at();

alter table public.caller_id_pool enable row level security;

drop policy if exists caller_id_pool_select on public.caller_id_pool;
create policy caller_id_pool_select on public.caller_id_pool
  for select using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  );

drop policy if exists caller_id_pool_write on public.caller_id_pool;
create policy caller_id_pool_write on public.caller_id_pool
  for all using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  ) with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('calls.manage')
  );

-- Atomically choose and mark the least-recently-used eligible number.
-- Area-code matches rank first; otherwise the least-recently-used eligible
-- pool number is returned. Only active outbound-capable numbers are eligible.
create or replace function public.select_caller_id_from_pool(
  p_organization_id uuid,
  p_destination_area_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone_number_id uuid;
begin
  select pool.phone_number_id
    into v_phone_number_id
  from public.caller_id_pool pool
  join public.phone_numbers pn
    on pn.id = pool.phone_number_id
   and pn.organization_id = pool.organization_id
  where pool.organization_id = p_organization_id
    and pool.enabled = true
    and pn.status = 'active'
    and coalesce((pn.capabilities ->> 'voice_outbound')::boolean, false) = true
  order by
    (p_destination_area_code is not null
      and left(pn.phone_number, 2) = '+1'
      and substring(pn.phone_number from 3 for 3) = p_destination_area_code) desc,
    pool.last_selected_at asc,
    pool.created_at asc
  for update of pool skip locked
  limit 1;

  if v_phone_number_id is null then
    return null;
  end if;

  update public.caller_id_pool
     set last_selected_at = clock_timestamp(),
         selection_count = selection_count + 1,
         updated_at = clock_timestamp()
   where organization_id = p_organization_id
     and phone_number_id = v_phone_number_id;

  return v_phone_number_id;
end;
$$;

revoke all on function public.select_caller_id_from_pool(uuid, text) from public, anon, authenticated;
grant execute on function public.select_caller_id_from_pool(uuid, text) to service_role;

-- Outcomes are already persisted in calls.status/answered_at/duration_seconds.
-- This view exposes per-number aggregates for reputation monitoring while
-- honoring the underlying calls RLS policies.
create or replace view public.caller_id_reputation_summary
with (security_invoker = true)
as
select
  c.organization_id,
  c.phone_number_id,
  count(*)::bigint as total_calls,
  count(*) filter (where c.answered_at is not null)::bigint as answered_calls,
  count(*) filter (where c.status = 'failed')::bigint as failed_calls,
  count(*) filter (where c.ended_at is not null)::bigint as ended_calls,
  round(
    100.0 * count(*) filter (where c.answered_at is not null)
    / nullif(count(*), 0),
    2
  ) as answer_rate_percent,
  max(c.created_at) as last_call_at
from public.calls c
where c.direction = 'outbound'
group by c.organization_id, c.phone_number_id;

comment on table public.caller_id_pool is
  'Opt-in caller-ID pool. Existing call routing is unchanged unless organization settings explicitly enable caller_id_routing_enabled.';
