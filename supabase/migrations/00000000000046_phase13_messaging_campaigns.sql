-- Phase 13: SMS campaigns/messages, email campaigns/messages, email
-- suppression (master spec sections 38, 40, 41, and the opt-out handling
-- concept from section 60).
--
-- SMS sending reuses Phase 5's phone_number_provider_credentials (Twilio/
-- Telnyx) - there is NO separate SMS credential store. sms_campaigns.
-- phone_number_id must reference one of the org's own phone_numbers rows
-- with SMS capability (validated in application code - see
-- routes/smsCampaigns.ts - since a jsonb capabilities column can't be
-- expressed as a SQL CHECK/FK).
--
-- Both sms_messages and email_messages are pre-materialized (one row per
-- lead) at campaign start, not generated lazily per dispatch tick - see
-- services/smsDispatcher.ts / services/emailDispatcher.ts header comments
-- for why: it matches the UNIQUE(campaign_id, lead_id) constraint's
-- dedup intent exactly (every lead gets AT MOST one row, decided once,
-- up front) and makes "how many are left to send" a plain COUNT query
-- rather than something the dispatcher has to reconstruct from the lead
-- list every tick.
--
-- Email delivered/bounced/replied tracking is HONESTLY NOT IMPLEMENTED
-- here: raw SMTP gives no delivery/bounce/reply signal at all (that
-- requires a transactional email provider's own webhook API, which is
-- out of this phase's scope - see services/emailDispatcher.ts). Those
-- states remain in the status CHECK constraint for a future real
-- integration, but nothing in this phase ever writes them.

create table if not exists public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name text not null check (char_length(name) between 1 and 200),
  -- {{first_name}} etc. per spec section 83 - rendered per-lead via the
  -- same lib/promptVariables.ts helper Phase 7's campaign prompts use.
  message_template text not null check (char_length(message_template) between 1 and 1600),

  phone_number_id uuid not null references public.phone_numbers (id) on delete restrict,
  lead_list_id uuid references public.lead_lists (id) on delete set null,

  status text not null default 'draft' check (status in (
    'draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'
  )),

  throttle_per_minute integer not null default 30 check (throttle_per_minute >= 1),
  scheduled_at timestamptz,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sms_campaigns_organization_id_idx on public.sms_campaigns (organization_id);
create index if not exists sms_campaigns_status_idx on public.sms_campaigns (status);
create index if not exists sms_campaigns_phone_number_id_idx on public.sms_campaigns (phone_number_id);

drop trigger if exists sms_campaigns_set_updated_at on public.sms_campaigns;
create trigger sms_campaigns_set_updated_at
  before update on public.sms_campaigns
  for each row execute function public.set_updated_at();

alter table public.sms_campaigns enable row level security;

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  sms_campaign_id uuid not null references public.sms_campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,

  phone_e164 text not null,
  rendered_body text not null,

  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'failed', 'replied')),
  provider_message_id text,
  error text,

  sent_at timestamptz,
  delivered_at timestamptz,

  created_at timestamptz not null default now()
);

-- The dedup guarantee: at most one message per (campaign, lead), enforced
-- by Postgres regardless of how many dispatch ticks/processes race to
-- materialize or send it.
create unique index if not exists sms_messages_campaign_lead_key on public.sms_messages (sms_campaign_id, lead_id);
create index if not exists sms_messages_organization_id_idx on public.sms_messages (organization_id);
create index if not exists sms_messages_status_idx on public.sms_messages (status);
-- Dispatcher's claim query: campaign_id + status='queued', batched.
create index if not exists sms_messages_dispatch_idx on public.sms_messages (sms_campaign_id, status);
create index if not exists sms_messages_provider_message_id_idx on public.sms_messages (provider_message_id);

alter table public.sms_messages enable row level security;

-- ---------------------------------------------------------------------
-- email_campaigns / email_messages
-- ---------------------------------------------------------------------
create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name text not null check (char_length(name) between 1 and 200),
  subject text not null check (char_length(subject) between 1 and 500),
  html_body text not null,
  plain_text_body text not null default '',

  -- Alternative recipient sources - exactly one is expected to be set by
  -- the route layer, but both are nullable at the schema level so a draft
  -- can be saved before either is chosen.
  recipient_lead_list_id uuid references public.lead_lists (id) on delete set null,
  -- Free-form filter, e.g. { campaign_id, disposition } - interpreted by
  -- services/emailDispatcher.ts's recipient-resolution step, not by SQL.
  recipient_filter jsonb,

  status text not null default 'draft' check (status in (
    'draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'
  )),

  throttle_per_minute integer not null default 30 check (throttle_per_minute >= 1),
  scheduled_at timestamptz,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_campaigns_organization_id_idx on public.email_campaigns (organization_id);
create index if not exists email_campaigns_status_idx on public.email_campaigns (status);

drop trigger if exists email_campaigns_set_updated_at on public.email_campaigns;
create trigger email_campaigns_set_updated_at
  before update on public.email_campaigns
  for each row execute function public.set_updated_at();

alter table public.email_campaigns enable row level security;

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  email_campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,

  recipient_email citext not null,
  rendered_subject text not null,
  rendered_html text not null,

  -- 'delivered'/'bounced'/'replied' remain valid values for a FUTURE
  -- transactional-provider webhook integration (not built in this phase -
  -- see this file's header comment) - nothing here ever writes them.
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'delivered', 'bounced', 'replied')),
  error text,

  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists email_messages_campaign_lead_key on public.email_messages (email_campaign_id, lead_id);
create index if not exists email_messages_organization_id_idx on public.email_messages (organization_id);
create index if not exists email_messages_status_idx on public.email_messages (status);
create index if not exists email_messages_dispatch_idx on public.email_messages (email_campaign_id, status);

alter table public.email_messages enable row level security;

-- ---------------------------------------------------------------------
-- email_suppressions - the email-channel equivalent of dnc_entries
-- (phone). Deliberately a SEPARATE table/concept: opting an email address
-- out of messaging must never suppress that same contact's phone DNC
-- status and vice versa (spec section 60's "opt-out handling" is
-- per-channel).
-- ---------------------------------------------------------------------
create table if not exists public.email_suppressions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  email citext not null,
  reason text,
  source text not null default 'manual' check (source in ('manual', 'unsubscribe', 'bounce')),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists email_suppressions_org_email_key
  on public.email_suppressions (organization_id, email) where organization_id is not null;
create unique index if not exists email_suppressions_global_email_key
  on public.email_suppressions (email) where organization_id is null;
create index if not exists email_suppressions_organization_id_idx on public.email_suppressions (organization_id);
create index if not exists email_suppressions_email_idx on public.email_suppressions (email);

alter table public.email_suppressions enable row level security;
