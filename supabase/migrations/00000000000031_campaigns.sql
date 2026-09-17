-- Phase 7: campaigns, campaign_versions, campaign_leads, campaign_settings,
-- dialing_settings, campaign_lead_skip_log.
--
-- Master spec sections 7-12, 83-85. The campaign is the unit that ties a
-- lead list, an AI agent (a specific PUBLISHED version), a voice, a
-- transfer number and a calling schedule together and drives real outbound
-- dialing through Phase 6's orchestration layer.
--
-- Per spec 84/85: publishing a campaign_versions row SNAPSHOTS the agent
-- version id/voice id/knowledge base ids/transfer number/calling rules at
-- that moment into the version's OWN columns. Later edits to the
-- underlying ai_agent/voice/knowledge_base never retroactively change a
-- campaign_versions row that has already been published - the dispatcher
-- (services/campaignDispatcher.ts) always reads the campaign's
-- current_version_id snapshot, never the live agent/voice tables, when
-- placing a call.

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name text not null check (char_length(name) between 1 and 200),
  description text,

  status text not null default 'draft' check (status in (
    'draft', 'scheduled', 'running', 'paused', 'completed', 'stopped', 'failed', 'archived'
  )),

  timezone text not null default 'America/New_York',
  calling_window_start time not null default '09:00',
  calling_window_end time not null default '18:00',
  -- ISO weekday numbers 1 (Monday) .. 7 (Sunday) that this campaign is
  -- allowed to dial on.
  calling_days jsonb not null default '[1,2,3,4,5]'::jsonb,

  start_date date,
  end_date date,

  concurrency_limit integer not null default 5 check (concurrency_limit >= 1),
  calls_per_minute_limit integer check (calls_per_minute_limit is null or calls_per_minute_limit >= 1),

  current_version_id uuid, -- FK added below once campaign_versions exists
  phone_number_id uuid references public.phone_numbers (id) on delete restrict,

  transfer_number_e164 text check (transfer_number_e164 is null or transfer_number_e164 ~ '^\+[1-9]\d{6,14}$'),

  voicemail_detection_enabled boolean not null default true,
  voicemail_message text,
  leave_voicemail boolean not null default true,

  lead_cooldown_minutes integer not null default 1440 check (lead_cooldown_minutes >= 0),

  background_noise text check (background_noise is null or background_noise in ('off', 'low', 'medium', 'high')),

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_organization_id_idx on public.campaigns (organization_id);
create index if not exists campaigns_status_idx on public.campaigns (status);
create index if not exists campaigns_phone_number_id_idx on public.campaigns (phone_number_id);
create index if not exists campaigns_created_at_idx on public.campaigns (created_at);

drop trigger if exists campaigns_set_updated_at on public.campaigns;
create trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

alter table public.campaigns enable row level security;

-- ---------------------------------------------------------------------
-- campaign_versions - the immutable, snapshotted configuration.
-- ---------------------------------------------------------------------
create table if not exists public.campaign_versions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  version_number integer not null check (version_number >= 1),

  -- {{variable}} template support - see packages/shared/src/campaign.ts
  -- for the exact variable-substitution contract used at call time.
  prompt text not null default '',

  ai_agent_id uuid references public.ai_agents (id) on delete set null,
  -- Snapshot: the EXACT published ai_agent_versions row locked in at
  -- publish time (spec 84). Never re-resolved from ai_agents.
  -- current_version_id after publish.
  ai_agent_version_id uuid references public.ai_agent_versions (id) on delete set null,
  -- Snapshot of the voice in effect at publish time.
  voice_id uuid references public.voices (id) on delete set null,
  -- Snapshot of the knowledge base document ids attached at publish time.
  knowledge_base_ids jsonb not null default '[]'::jsonb,
  script_id uuid references public.scripts (id) on delete set null,

  transfer_number_e164 text check (transfer_number_e164 is null or transfer_number_e164 ~ '^\+[1-9]\d{6,14}$'),

  -- Snapshot of calling-window/days/cooldown/voicemail config at publish
  -- time: { timezone, calling_window_start, calling_window_end,
  -- calling_days, lead_cooldown_minutes, voicemail_detection_enabled,
  -- voicemail_message, leave_voicemail, background_noise }.
  calling_rules jsonb not null default '{}'::jsonb,
  -- Snapshot of disposition-handling rules at publish time: { retry_on:
  -- [...ended_reasons], max_attempts, retry_delay_minutes }.
  disposition_rules jsonb not null default '{}'::jsonb,

  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists campaign_versions_campaign_version_key
  on public.campaign_versions (campaign_id, version_number);
create index if not exists campaign_versions_campaign_id_idx on public.campaign_versions (campaign_id);
create index if not exists campaign_versions_organization_id_idx on public.campaign_versions (organization_id);
create index if not exists campaign_versions_status_idx on public.campaign_versions (status);

alter table public.campaign_versions enable row level security;

alter table public.campaigns
  drop constraint if exists campaigns_current_version_id_fkey;
alter table public.campaigns
  add constraint campaigns_current_version_id_fkey
  foreign key (current_version_id) references public.campaign_versions (id) on delete set null;

-- ---------------------------------------------------------------------
-- campaign_leads - per-lead campaign state (spec section 11).
-- ---------------------------------------------------------------------
create table if not exists public.campaign_leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,

  status text not null default 'pending' check (status in (
    'pending', 'queued', 'dialing', 'ringing', 'connected', 'in_progress',
    'transferring', 'completed', 'failed', 'retry_pending', 'skipped', 'dnc'
  )),

  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_eligible_at timestamptz,
  last_call_id uuid references public.calls (id) on delete set null,
  final_disposition text,

  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists campaign_leads_campaign_lead_key on public.campaign_leads (campaign_id, lead_id);
create index if not exists campaign_leads_campaign_id_idx on public.campaign_leads (campaign_id);
create index if not exists campaign_leads_organization_id_idx on public.campaign_leads (organization_id);
create index if not exists campaign_leads_lead_id_idx on public.campaign_leads (lead_id);
create index if not exists campaign_leads_status_idx on public.campaign_leads (status);
-- Critical for the dispatcher's eligibility query at 10k+ leads: pulling
-- the next eligible batch is `campaign_id = ? and status in (...) and
-- (next_eligible_at is null or next_eligible_at <= now()) order by
-- next_eligible_at nulls first, added_at` - this composite index keeps
-- that an index scan, never a full-table scan.
create index if not exists campaign_leads_dispatch_idx
  on public.campaign_leads (campaign_id, status, next_eligible_at);

drop trigger if exists campaign_leads_set_updated_at on public.campaign_leads;
create trigger campaign_leads_set_updated_at
  before update on public.campaign_leads
  for each row execute function public.set_updated_at();

alter table public.campaign_leads enable row level security;

-- ---------------------------------------------------------------------
-- campaign_lead_skip_log - queryable record of WHY a lead was judged
-- ineligible on a given dispatch tick, so eligibility exclusions are never
-- silently lost (spec section 11). Append-only, no updated_at.
-- ---------------------------------------------------------------------
create table if not exists public.campaign_lead_skip_log (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  reason_code text not null,
  reason_message text not null,
  occurred_at timestamptz not null default now()
);

create index if not exists campaign_lead_skip_log_campaign_id_idx on public.campaign_lead_skip_log (campaign_id);
create index if not exists campaign_lead_skip_log_lead_id_idx on public.campaign_lead_skip_log (lead_id);
create index if not exists campaign_lead_skip_log_occurred_at_idx on public.campaign_lead_skip_log (occurred_at);

alter table public.campaign_lead_skip_log enable row level security;

-- ---------------------------------------------------------------------
-- campaign_settings - free-form per-campaign overrides (AMD sensitivity,
-- retry policy overrides, busy/no-answer behavior). key/value jsonb so new
-- override keys never require a migration.
-- ---------------------------------------------------------------------
create table if not exists public.campaign_settings (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  key text not null,
  value jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists campaign_settings_campaign_key_key on public.campaign_settings (campaign_id, key);
create index if not exists campaign_settings_organization_id_idx on public.campaign_settings (organization_id);

alter table public.campaign_settings enable row level security;

-- ---------------------------------------------------------------------
-- dialing_settings - org-level defaults (spec section 12). One default row
-- per org (is_default = true); campaigns override individual keys via
-- campaign_settings.
-- ---------------------------------------------------------------------
create table if not exists public.dialing_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  is_default boolean not null default true,

  default_concurrency integer not null default 5 check (default_concurrency >= 1),
  max_concurrency integer not null default 25 check (max_concurrency >= 1),
  calls_per_minute integer not null default 30 check (calls_per_minute >= 1),
  max_attempts integer not null default 3 check (max_attempts >= 1),
  retry_delay_minutes integer not null default 60 check (retry_delay_minutes >= 1),
  lead_cooldown_minutes integer not null default 1440 check (lead_cooldown_minutes >= 0),

  calling_hours_start time not null default '09:00',
  calling_hours_end time not null default '18:00',

  voicemail_behavior text not null default 'leave_message' check (voicemail_behavior in ('leave_message', 'hang_up', 'retry_later')),
  amd_enabled boolean not null default true,
  dnc_behavior text not null default 'skip' check (dnc_behavior in ('skip')),
  failed_call_behavior text not null default 'retry' check (failed_call_behavior in ('retry', 'skip')),
  busy_behavior text not null default 'retry' check (busy_behavior in ('retry', 'skip')),
  no_answer_behavior text not null default 'retry' check (no_answer_behavior in ('retry', 'skip')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists dialing_settings_org_default_key
  on public.dialing_settings (organization_id) where is_default;
create index if not exists dialing_settings_organization_id_idx on public.dialing_settings (organization_id);

drop trigger if exists dialing_settings_set_updated_at on public.dialing_settings;
create trigger dialing_settings_set_updated_at
  before update on public.dialing_settings
  for each row execute function public.set_updated_at();

alter table public.dialing_settings enable row level security;

-- ---------------------------------------------------------------------
-- Wire up the deferred FKs from Phase 5/6.
-- ---------------------------------------------------------------------
alter table public.calls
  drop constraint if exists calls_campaign_id_fkey;
alter table public.calls
  add constraint calls_campaign_id_fkey
  foreign key (campaign_id) references public.campaigns (id) on delete set null;
create index if not exists calls_campaign_id_idx on public.calls (campaign_id);

alter table public.phone_numbers
  drop constraint if exists phone_numbers_assigned_campaign_id_fkey;
alter table public.phone_numbers
  add constraint phone_numbers_assigned_campaign_id_fkey
  foreign key (assigned_campaign_id) references public.campaigns (id) on delete set null;
create index if not exists phone_numbers_assigned_campaign_id_idx on public.phone_numbers (assigned_campaign_id);

-- ---------------------------------------------------------------------
-- Permissions: campaigns.view/create/edit/start/pause/delete already exist
-- from the Phase 1 seed catalog (00000000000009) and are already granted
-- to SUPER_ADMIN/ADMIN (all permissions) and MANAGER/AGENT/VIEWER per that
-- seed's existing rules. Nothing new to insert here.
