-- Phase 12: Analytics - pre-aggregated rollup tables (master spec
-- sections 6, 42, 89 - "don't compute expensive analytics from raw
-- events on every dashboard load").
--
-- Four rollup tables, kept up to date by
-- apps/backend/src/services/analyticsAggregator.ts (an in-process
-- setInterval job, same established pattern as Phase 7's campaign
-- dispatcher) via the recompute_* SQL functions in
-- 00000000000044_phase12_analytics_rollup_fns.sql. The dashboard/
-- analytics API (routes/dashboard.ts, routes/analytics.ts) reads these
-- tables for anything beyond "today" - never a live scan of the full
-- `calls` table for a historical period. "Today"'s row is always
-- recomputed on every aggregator tick (documented choice - see that
-- service's header comment), and a small number of genuinely real-time
-- figures (active calls, remaining leads, campaigns running, AI agents
-- active) are always live queries, never rollups, per the spec.

create table if not exists public.analytics_daily_org (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  date date not null,

  total_calls integer not null default 0,
  calls_connected integer not null default 0,
  calls_completed integer not null default 0,
  calls_failed integer not null default 0,
  voicemails integer not null default 0,
  answering_machines integer not null default 0,
  dnc_count integer not null default 0,
  not_interested_count integer not null default 0,
  transfers integer not null default 0,
  callbacks_scheduled integer not null default 0,
  avg_call_duration_seconds numeric(10, 2),
  avg_talk_time_seconds numeric(10, 2),

  updated_at timestamptz not null default now(),

  primary key (organization_id, date)
);

create index if not exists analytics_daily_org_org_date_idx on public.analytics_daily_org (organization_id, date desc);

alter table public.analytics_daily_org enable row level security;

create table if not exists public.analytics_daily_campaign (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  date date not null,

  total_calls integer not null default 0,
  connected integer not null default 0,
  voicemail integer not null default 0,
  dnc integer not null default 0,
  transfers integer not null default 0,
  callbacks integer not null default 0,
  failed integer not null default 0,
  avg_duration_seconds numeric(10, 2),
  -- Snapshot-at-aggregation-time counts (never re-derived from raw calls
  -- by the API) - see this migration's header + the aggregator's own
  -- header comment for exactly what "as of aggregation time" means here.
  leads_called integer not null default 0,
  leads_remaining integer not null default 0,

  updated_at timestamptz not null default now(),

  primary key (organization_id, campaign_id, date)
);

create index if not exists analytics_daily_campaign_org_date_idx on public.analytics_daily_campaign (organization_id, date desc);
create index if not exists analytics_daily_campaign_campaign_idx on public.analytics_daily_campaign (campaign_id, date desc);

alter table public.analytics_daily_campaign enable row level security;

create table if not exists public.analytics_daily_agent (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ai_agent_id uuid not null references public.ai_agents (id) on delete cascade,
  date date not null,

  total_calls integer not null default 0,
  connected integer not null default 0,
  avg_duration_seconds numeric(10, 2),
  transfers integer not null default 0,
  dnc integer not null default 0,
  voicemail integer not null default 0,
  avg_evaluation_score numeric(5, 2),

  updated_at timestamptz not null default now(),

  primary key (organization_id, ai_agent_id, date)
);

create index if not exists analytics_daily_agent_org_date_idx on public.analytics_daily_agent (organization_id, date desc);
create index if not exists analytics_daily_agent_agent_idx on public.analytics_daily_agent (ai_agent_id, date desc);

alter table public.analytics_daily_agent enable row level security;

create table if not exists public.analytics_hourly_org (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  hour_bucket timestamptz not null,

  total_calls integer not null default 0,
  calls_connected integer not null default 0,

  updated_at timestamptz not null default now(),

  primary key (organization_id, hour_bucket)
);

create index if not exists analytics_hourly_org_org_hour_idx on public.analytics_hourly_org (organization_id, hour_bucket desc);

alter table public.analytics_hourly_org enable row level security;
