-- Phase 12: the real SQL aggregate (COUNT/AVG/GROUP BY) functions that
-- compute and upsert the 4 rollup tables, following the exact
-- `agent_evaluation_summary()` pattern from
-- 00000000000041_phase11_evaluation_summary_fn.sql - real Postgres
-- aggregation, never fetched-raw-rows-and-summed-in-JS.
--
-- Each function recomputes and upserts EXACTLY ONE rollup row (or, for
-- the per-campaign/per-agent functions, one row per campaign/agent that
-- had activity that day) for a single organization + date/hour, so it is
-- naturally idempotent - running it twice for the same
-- organization/date produces the same row via ON CONFLICT DO UPDATE,
-- never a duplicate or an accumulated double-count. This is what
-- services/analyticsAggregator.ts calls on every tick (today's row,
-- always recomputed) and once per historical date during its one-time
-- backfill.
--
-- "Connected" is defined consistently across every function in this file
-- as `answered_at is not null` - a call that was actually picked up,
-- regardless of its eventual disposition - distinct from "completed"
-- (status = 'completed', i.e. the call finished in that terminal state).

create or replace function public.recompute_analytics_daily_org(
  p_org_id uuid,
  p_date date
)
returns void
language plpgsql
as $$
begin
  insert into public.analytics_daily_org (
    organization_id, date, total_calls, calls_connected, calls_completed, calls_failed,
    voicemails, answering_machines, dnc_count, not_interested_count, transfers,
    callbacks_scheduled, avg_call_duration_seconds, avg_talk_time_seconds, updated_at
  )
  select
    p_org_id,
    p_date,
    count(*) filter (where true),
    count(*) filter (where c.answered_at is not null),
    count(*) filter (where c.status = 'completed'),
    count(*) filter (where c.status = 'failed'),
    count(*) filter (where d.code = 'VOICEMAIL'),
    count(*) filter (where d.code = 'ANSWERING_MACHINE'),
    count(*) filter (where d.code = 'DNC'),
    count(*) filter (where d.code = 'NOT_INTERESTED'),
    count(*) filter (where d.code = 'TRANSFERRED'),
    (select count(*) from public.callbacks cb where cb.organization_id = p_org_id and cb.created_at::date = p_date),
    round(avg(c.duration_seconds) filter (where c.duration_seconds is not null), 2),
    round(avg(c.talk_duration_seconds) filter (where c.talk_duration_seconds is not null), 2),
    now()
  from public.calls c
  left join public.call_dispositions cd on cd.call_id = c.id and cd.organization_id = p_org_id
  left join public.dispositions d on d.id = cd.disposition_id
  where c.organization_id = p_org_id
    and c.created_at::date = p_date
  on conflict (organization_id, date) do update set
    total_calls = excluded.total_calls,
    calls_connected = excluded.calls_connected,
    calls_completed = excluded.calls_completed,
    calls_failed = excluded.calls_failed,
    voicemails = excluded.voicemails,
    answering_machines = excluded.answering_machines,
    dnc_count = excluded.dnc_count,
    not_interested_count = excluded.not_interested_count,
    transfers = excluded.transfers,
    callbacks_scheduled = excluded.callbacks_scheduled,
    avg_call_duration_seconds = excluded.avg_call_duration_seconds,
    avg_talk_time_seconds = excluded.avg_talk_time_seconds,
    updated_at = now();
  -- The SELECT above has no GROUP BY, so its bare aggregates (count(*),
  -- avg(...) filter (...)) always produce exactly one row - 0/null when
  -- there are genuinely no calls that day - which the upsert above
  -- writes as a real zeroed row. A day with zero calls is never simply
  -- absent from the table, so a chart iterating every date in a range
  -- never has to special-case a missing row as zero.
end;
$$;

create or replace function public.recompute_analytics_daily_campaign(
  p_org_id uuid,
  p_date date
)
returns void
language plpgsql
as $$
begin
  insert into public.analytics_daily_campaign (
    organization_id, campaign_id, date, total_calls, connected, voicemail, dnc, transfers,
    callbacks, failed, avg_duration_seconds, leads_called, leads_remaining, updated_at
  )
  select
    p_org_id,
    c.campaign_id,
    p_date,
    count(*) as total_calls,
    count(*) filter (where c.answered_at is not null) as connected,
    count(*) filter (where d.code = 'VOICEMAIL') as voicemail,
    count(*) filter (where d.code = 'DNC') as dnc,
    count(*) filter (where d.code = 'TRANSFERRED') as transfers,
    (
      select count(*) from public.callbacks cb
      where cb.organization_id = p_org_id and cb.campaign_id = c.campaign_id and cb.created_at::date = p_date
    ) as callbacks,
    count(*) filter (where c.status = 'failed') as failed,
    round(avg(c.duration_seconds) filter (where c.duration_seconds is not null), 2) as avg_duration_seconds,
    count(distinct c.lead_id) as leads_called,
    -- "As of aggregation time" live snapshot, not a historical figure -
    -- see this migration file's header comment.
    (
      select count(*) from public.campaign_leads cl
      where cl.campaign_id = c.campaign_id
        and cl.status not in ('completed', 'failed', 'dnc', 'skipped')
    ) as leads_remaining,
    now()
  from public.calls c
  left join public.call_dispositions cd on cd.call_id = c.id and cd.organization_id = p_org_id
  left join public.dispositions d on d.id = cd.disposition_id
  where c.organization_id = p_org_id
    and c.created_at::date = p_date
    and c.campaign_id is not null
  group by c.campaign_id
  on conflict (organization_id, campaign_id, date) do update set
    total_calls = excluded.total_calls,
    connected = excluded.connected,
    voicemail = excluded.voicemail,
    dnc = excluded.dnc,
    transfers = excluded.transfers,
    callbacks = excluded.callbacks,
    failed = excluded.failed,
    avg_duration_seconds = excluded.avg_duration_seconds,
    leads_called = excluded.leads_called,
    leads_remaining = excluded.leads_remaining,
    updated_at = now();
end;
$$;

create or replace function public.recompute_analytics_daily_agent(
  p_org_id uuid,
  p_date date
)
returns void
language plpgsql
as $$
begin
  insert into public.analytics_daily_agent (
    organization_id, ai_agent_id, date, total_calls, connected, avg_duration_seconds,
    transfers, dnc, voicemail, avg_evaluation_score, updated_at
  )
  select
    p_org_id,
    c.ai_agent_id,
    p_date,
    count(*) as total_calls,
    count(*) filter (where c.answered_at is not null) as connected,
    round(avg(c.duration_seconds) filter (where c.duration_seconds is not null), 2) as avg_duration_seconds,
    count(*) filter (where d.code = 'TRANSFERRED') as transfers,
    count(*) filter (where d.code = 'DNC') as dnc,
    count(*) filter (where d.code = 'VOICEMAIL') as voicemail,
    (
      select round(avg(ce.overall_score), 2) from public.call_evaluations ce
      where ce.organization_id = p_org_id
        and ce.call_id in (select id from public.calls where ai_agent_id = c.ai_agent_id and organization_id = p_org_id and created_at::date = p_date)
    ) as avg_evaluation_score,
    now()
  from public.calls c
  left join public.call_dispositions cd on cd.call_id = c.id and cd.organization_id = p_org_id
  left join public.dispositions d on d.id = cd.disposition_id
  where c.organization_id = p_org_id
    and c.created_at::date = p_date
    and c.ai_agent_id is not null
  group by c.ai_agent_id
  on conflict (organization_id, ai_agent_id, date) do update set
    total_calls = excluded.total_calls,
    connected = excluded.connected,
    avg_duration_seconds = excluded.avg_duration_seconds,
    transfers = excluded.transfers,
    dnc = excluded.dnc,
    voicemail = excluded.voicemail,
    avg_evaluation_score = excluded.avg_evaluation_score,
    updated_at = now();
end;
$$;

create or replace function public.recompute_analytics_hourly_org(
  p_org_id uuid,
  p_hour timestamptz
)
returns void
language plpgsql
as $$
declare
  v_hour timestamptz := date_trunc('hour', p_hour);
begin
  insert into public.analytics_hourly_org (organization_id, hour_bucket, total_calls, calls_connected, updated_at)
  select
    p_org_id,
    v_hour,
    count(*),
    count(*) filter (where c.answered_at is not null),
    now()
  from public.calls c
  where c.organization_id = p_org_id
    and date_trunc('hour', c.created_at) = v_hour
  on conflict (organization_id, hour_bucket) do update set
    total_calls = excluded.total_calls,
    calls_connected = excluded.calls_connected,
    updated_at = now();
  -- Same "bare aggregate always yields one row" reasoning as
  -- recompute_analytics_daily_org above - an hour with zero calls still
  -- gets a real zeroed row, never a gap.
end;
$$;

-- Real-time disposition breakdown for a bounded date range (the one chart
-- the spec explicitly calls out as "plus call_dispositions GROUP BY" on
-- top of the rollup tables - a targeted indexed join over a bounded
-- range, not an unbounded scan of `calls`).
create or replace function public.dashboard_disposition_breakdown(
  match_organization_id uuid,
  match_from timestamptz,
  match_to timestamptz
)
returns table (code text, name text, call_count bigint)
language sql
stable
as $$
  select d.code, d.name, count(*) as call_count
  from public.call_dispositions cd
  join public.calls c on c.id = cd.call_id
  join public.dispositions d on d.id = cd.disposition_id
  where cd.organization_id = match_organization_id
    and c.organization_id = match_organization_id
    and c.created_at >= match_from
    and c.created_at < match_to
  group by d.code, d.name
  order by call_count desc;
$$;
