-- One backend process at a time runs the background workers (campaign
-- dialer, callbacks, sweeps). During a deploy the old and new containers
-- both run for a while - with slow deploys, for minutes - and each one
-- dialed its own calls, so campaigns went over their concurrency limit
-- (29 Sep 2026). The workers now start only in the process holding this
-- lease; the holder renews it every few seconds and releases it on
-- shutdown.
create table if not exists public.worker_leases (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null
);

alter table public.worker_leases enable row level security;

-- Takes the lease when it is free or expired, or renews it for its current
-- holder. True when p_holder holds the lease afterwards.
create or replace function public.claim_worker_lease(p_name text, p_holder text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder text;
begin
  insert into public.worker_leases as wl (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
     set holder = excluded.holder,
         expires_at = excluded.expires_at
   where wl.holder = excluded.holder or wl.expires_at < now()
  returning holder into v_holder;
  return v_holder is not null and v_holder = p_holder;
end;
$$;

create or replace function public.release_worker_lease(p_name text, p_holder text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.worker_leases
     set expires_at = now() - interval '1 second'
   where name = p_name and holder = p_holder;
$$;

revoke all on function public.claim_worker_lease(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_worker_lease(text, text) from public, anon, authenticated;
grant execute on function public.claim_worker_lease(text, text, integer) to service_role;
grant execute on function public.release_worker_lease(text, text) to service_role;
