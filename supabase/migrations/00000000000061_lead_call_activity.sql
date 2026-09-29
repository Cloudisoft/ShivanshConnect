-- Keeps each lead's call activity current: attempts, last_called_at,
-- last_disposition, next_callback_at and status.
--
-- These columns (and the Leads page columns/filters built on them) were
-- never written by anything, so every lead showed status NEW, 0 attempts
-- and no last call however many times it was called. Maintained here by
-- triggers so every path is covered - campaign dialer, callbacks, manual
-- calls, inbound, disposition overrides - then backfilled from history.

-- A call's disposition code -> the lead's status.
create or replace function public.lead_status_for_disposition(code text)
returns text
language sql
immutable
as $$
  select case upper(coalesce(code, ''))
    when 'DNC' then 'DNC'
    when 'TRANSFERRED' then 'TRANSFERRED'
    when 'VOICEMAIL' then 'VOICEMAIL'
    when 'ANSWERING_MACHINE' then 'VOICEMAIL'
    when 'NO_ANSWER' then 'NO_ANSWER'
    when 'NOT_IN_SERVICE' then 'FAILED'
    when 'NOT_INTERESTED' then 'COMPLETED'
    when 'CALL_CONNECTED' then 'CONNECTED'
    when 'HUNG_UP' then 'CONNECTED'
    when 'CALL_DISCONNECTED_IN_TRANSFER' then 'CONNECTED'
    else 'CALLED'
  end
$$;

-- An outbound call placed to a lead: one more attempt.
create or replace function public.leads_track_call()
returns trigger
language plpgsql
as $$
begin
  update public.leads
     set attempts = attempts + 1,
         last_called_at = greatest(coalesce(last_called_at, new.created_at), new.created_at),
         status = case
           when is_dnc or status = 'DNC' then 'DNC'
           when status in ('NEW', 'QUEUED') then 'CALLED'
           else status
         end
   where id = new.lead_id;
  return null;
end;
$$;

drop trigger if exists calls_track_lead_activity on public.calls;
create trigger calls_track_lead_activity
  after insert on public.calls
  for each row
  when (new.lead_id is not null and new.direction = 'outbound')
  execute function public.leads_track_call();

-- A call's disposition (engine or manual override): the lead's last
-- disposition and status - only from the lead's most recent call, so a
-- late report for an older call never overwrites a newer outcome.
create or replace function public.leads_track_disposition()
returns trigger
language plpgsql
as $$
declare
  v_lead_id uuid;
  v_created_at timestamptz;
  v_code text;
  v_name text;
begin
  select lead_id, created_at into v_lead_id, v_created_at from public.calls where id = new.call_id;
  if v_lead_id is null then
    return null;
  end if;
  if exists (select 1 from public.calls c where c.lead_id = v_lead_id and c.created_at > v_created_at) then
    return null;
  end if;
  select code, name into v_code, v_name from public.dispositions where id = new.disposition_id;

  update public.leads l
     set last_disposition = coalesce(v_name, v_code, l.last_disposition),
         status = case
           when l.is_dnc or l.status = 'DNC' or upper(coalesce(v_code, '')) = 'DNC' then 'DNC'
           when exists (
             select 1 from public.callbacks cb
              where cb.lead_id = l.id and cb.status in ('scheduled', 'pending', 'calling')
           ) then 'CALLBACK'
           else public.lead_status_for_disposition(v_code)
         end
   where l.id = v_lead_id;
  return null;
end;
$$;

drop trigger if exists call_dispositions_track_lead on public.call_dispositions;
create trigger call_dispositions_track_lead
  after insert or update of disposition_id on public.call_dispositions
  for each row
  execute function public.leads_track_disposition();

-- Callbacks scheduled/completed/cancelled: the lead's next callback time,
-- and CALLBACK status while one is pending.
create or replace function public.leads_track_callbacks()
returns trigger
language plpgsql
as $$
declare
  v_lead_id uuid := coalesce(new.lead_id, old.lead_id);
  v_next timestamptz;
begin
  select min(scheduled_at) into v_next
    from public.callbacks
   where lead_id = v_lead_id and status in ('scheduled', 'pending', 'calling');

  update public.leads
     set next_callback_at = v_next,
         status = case
           when is_dnc or status = 'DNC' then 'DNC'
           when v_next is not null then 'CALLBACK'
           when status = 'CALLBACK' then 'CALLED'
           else status
         end
   where id = v_lead_id;
  return null;
end;
$$;

drop trigger if exists callbacks_track_lead on public.callbacks;
create trigger callbacks_track_lead
  after insert or delete on public.callbacks
  for each row
  execute function public.leads_track_callbacks();

drop trigger if exists callbacks_track_lead_update on public.callbacks;
create trigger callbacks_track_lead_update
  after update of status, scheduled_at on public.callbacks
  for each row
  execute function public.leads_track_callbacks();

-- Backfill from existing history.
update public.leads l
   set attempts = s.n,
       last_called_at = s.last_at,
       status = case when l.is_dnc or l.status = 'DNC' then 'DNC' when l.status in ('NEW', 'QUEUED') then 'CALLED' else l.status end
  from (
    select lead_id, count(*)::int as n, max(created_at) as last_at
      from public.calls
     where lead_id is not null and direction = 'outbound'
     group by lead_id
  ) s
 where l.id = s.lead_id;

update public.leads l
   set last_disposition = coalesce(d.name, d.code),
       status = case
         when l.is_dnc or l.status = 'DNC' or upper(d.code) = 'DNC' then 'DNC'
         else public.lead_status_for_disposition(d.code)
       end
  from (
    select distinct on (c.lead_id) c.lead_id, cd.disposition_id
      from public.calls c
      join public.call_dispositions cd on cd.call_id = c.id
     where c.lead_id is not null
     order by c.lead_id, c.created_at desc
  ) latest
  join public.dispositions d on d.id = latest.disposition_id
 where l.id = latest.lead_id;

update public.leads l
   set next_callback_at = s.next_at,
       status = case when l.is_dnc or l.status = 'DNC' then 'DNC' else 'CALLBACK' end
  from (
    select lead_id, min(scheduled_at) as next_at
      from public.callbacks
     where status in ('scheduled', 'pending', 'calling')
     group by lead_id
  ) s
 where l.id = s.lead_id;
