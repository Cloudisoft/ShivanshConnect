-- Phase 6: call orchestration engines (Vapi + pipecat) + the one
-- authoritative internal call record.
--
-- Master spec sections 8E/18/19/30/31/101 (also 50, 58, 72). Section 101 is
-- explicit that a provider id (Vapi's assistant/call id, pipecat's own
-- call id) is never the app's identity for a call or an assistant - it is
-- a property stored on the one internal row. `calls` is that row
-- regardless of which engine actually handled the call.
--
-- vapi_credentials mirrors voice_provider_credentials/phone_number_
-- provider_credentials exactly (same AES-256-GCM helper), but Vapi is a
-- single provider, not a catalog of several, so there's one row per org
-- rather than a catalog table.
--
-- ai_agent_versions.vapi_assistant_id: set the first time a version is
-- pushed to Vapi via VapiProvider.createAssistant(); Vapi assistants are
-- immutable per Vapi's own model in the same way ai_agent_versions rows
-- are - a config edit creates a new local version (Phase 3's existing
-- versioning), which in turn gets its own new Vapi assistant on next
-- publish, exactly mirroring the local draft/publish flow.

alter table public.ai_agent_versions
  add column if not exists vapi_assistant_id text;

create index if not exists ai_agent_versions_vapi_assistant_id_idx
  on public.ai_agent_versions (vapi_assistant_id)
  where vapi_assistant_id is not null;

create table if not exists public.vapi_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- { iv, authTag, ciphertext } (base64) - AES-256-GCM, plaintext shape
  -- { api_key }. See lib/crypto/credentials.ts.
  encrypted_credentials jsonb not null,

  status text not null default 'not_connected' check (status in ('not_connected', 'connected', 'error')),
  last_verified_at timestamptz,
  last_error text,

  -- The org's own webhook server-url configured on the Vapi account via
  -- VapiProvider.registerWebhook() - kept here purely for display/audit,
  -- Vapi itself is the source of truth once set.
  webhook_url text,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists vapi_credentials_organization_id_key
  on public.vapi_credentials (organization_id);

drop trigger if exists vapi_credentials_set_updated_at on public.vapi_credentials;
create trigger vapi_credentials_set_updated_at
  before update on public.vapi_credentials
  for each row execute function public.set_updated_at();

alter table public.vapi_credentials enable row level security;

-- ---------------------------------------------------------------------
-- calls: the ONE authoritative internal call record, regardless of which
-- engine (vapi/pipecat) actually handled it. Status follows the Phase 50
-- call-state-machine enum; apps/backend/src/lib/orchestration/
-- callStateMachine.ts enforces which transitions are valid - this column
-- is a plain text check, not a DB-level state machine.
-- ---------------------------------------------------------------------
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  engine text not null check (engine in ('vapi', 'pipecat')),
  vapi_call_id text,
  pipecat_call_id text,

  ai_agent_id uuid not null references public.ai_agents (id) on delete restrict,
  ai_agent_version_id uuid not null references public.ai_agent_versions (id) on delete restrict,
  -- Deferred FK - campaigns doesn't exist until Phase 7 (same deferred-FK
  -- pattern as ai_agent_versions.voice_id in Phase 3, phone_numbers.
  -- assigned_campaign_id in Phase 5).
  campaign_id uuid,
  lead_id uuid references public.leads (id) on delete set null,
  phone_number_id uuid not null references public.phone_numbers (id) on delete restrict,

  direction text not null check (direction in ('inbound', 'outbound')),
  customer_number text not null,

  status text not null default 'queued' check (status in (
    'queued', 'dialing', 'ringing', 'answered', 'in_progress', 'voicemail',
    'answering_machine', 'transfer_pending', 'transferring', 'transferred',
    'transfer_failed', 'completed', 'failed', 'dnc', 'cancelled'
  )),

  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  talk_duration_seconds integer,
  ended_reason text,

  -- Server-side-injected only, per the spec 19/8L hard rule: the AI must
  -- never invent a transfer destination. Never write this column from a
  -- client- or AI-supplied value - always from the campaign/agent's own
  -- configured, pre-validated E.164 number.
  transfer_destination_e164 text,
  transfer_status text check (transfer_status in ('pending', 'in_progress', 'succeeded', 'failed')),

  cost numeric(10, 4),

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- vapi_call_id/pipecat_call_id need care per the task brief: RLS on calls
-- reads organization_id directly (a real column on this table), so no
-- extra RLS complexity is needed for them - they are just lookup keys for
-- inbound webhook resolution, always used together with an
-- organization_id check in application code (see routes/webhooks.ts).
create unique index if not exists calls_vapi_call_id_key on public.calls (vapi_call_id) where vapi_call_id is not null;
create unique index if not exists calls_pipecat_call_id_key on public.calls (pipecat_call_id) where pipecat_call_id is not null;

create index if not exists calls_organization_id_idx on public.calls (organization_id);
create index if not exists calls_status_idx on public.calls (status);
create index if not exists calls_created_at_idx on public.calls (created_at);
create index if not exists calls_ai_agent_id_idx on public.calls (ai_agent_id);
create index if not exists calls_lead_id_idx on public.calls (lead_id);
create index if not exists calls_phone_number_id_idx on public.calls (phone_number_id);

drop trigger if exists calls_set_updated_at on public.calls;
create trigger calls_set_updated_at
  before update on public.calls
  for each row execute function public.set_updated_at();

alter table public.calls enable row level security;

-- ---------------------------------------------------------------------
-- call_events: raw event log from either engine - append-only.
-- ---------------------------------------------------------------------
create table if not exists public.call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists call_events_call_id_idx on public.call_events (call_id);
create index if not exists call_events_organization_id_idx on public.call_events (organization_id);
create index if not exists call_events_event_type_idx on public.call_events (event_type);
create index if not exists call_events_occurred_at_idx on public.call_events (occurred_at);

alter table public.call_events enable row level security;

-- ---------------------------------------------------------------------
-- webhook_events: idempotent inbound-webhook ledger for vapi/pipecat/
-- twilio/telnyx. UNIQUE (provider, event_id) is the actual idempotency
-- guarantee - a replayed delivery of the same event hits this constraint
-- and is treated as already-processed, never reprocessed (spec 31/58).
-- organization_id is nullable because it may not be resolvable until the
-- payload itself is parsed (e.g. before the assistant/call id inside it
-- is looked up).
-- ---------------------------------------------------------------------
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  provider text not null check (provider in ('vapi', 'pipecat', 'twilio', 'telnyx')),
  -- The provider's own idempotency key for this specific delivery. Vapi:
  -- message.call.id + message.type + timestamp fallback when no single
  -- dedicated id is present (see routes/webhooks.ts's comment on exactly
  -- how this is derived per engine). Pipecat: the event id our own
  -- pipecat-service assigns per POST.
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'processing', 'processed', 'failed')),
  error text,
  retry_count integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists webhook_events_provider_event_id_key
  on public.webhook_events (provider, event_id);
create index if not exists webhook_events_organization_id_idx on public.webhook_events (organization_id);
create index if not exists webhook_events_processing_status_idx on public.webhook_events (processing_status);
create index if not exists webhook_events_received_at_idx on public.webhook_events (received_at);

alter table public.webhook_events enable row level security;

-- ---------------------------------------------------------------------
-- webhook_failures: dead-letter tracking (spec section 31).
-- ---------------------------------------------------------------------
create table if not exists public.webhook_failures (
  id uuid primary key default gen_random_uuid(),
  webhook_event_id uuid not null references public.webhook_events (id) on delete cascade,
  error text not null,
  failed_at timestamptz not null default now(),
  replayed_at timestamptz
);

create index if not exists webhook_failures_webhook_event_id_idx on public.webhook_failures (webhook_event_id);

alter table public.webhook_failures enable row level security;

-- ---------------------------------------------------------------------
-- New permissions for Phase 6. The Phase 1 seed migration
-- (00000000000009) already anticipated most of the permission catalog for
-- later phases, but call origination/viewing and the webhook admin log
-- have no exact match there (cdr.view/cdr.export are for Phase 9's call
-- detail records specifically) - add two narrowly-scoped new keys rather
-- than overload an unrelated one.
-- ---------------------------------------------------------------------
insert into public.permissions (key, description, category)
values
  ('calls.manage', 'Originate and view calls through an orchestration engine', 'calls'),
  ('webhooks.manage', 'View and replay orchestration webhook events', 'calls')
on conflict (key) do nothing;

-- SUPER_ADMIN/ADMIN already get every permission via the Phase 1 seed's
-- "cross join every permission" rule for those two roles - nothing to do
-- there. MANAGER gets everything except role/user/settings admin (same
-- Phase 1 rule), which both new keys satisfy automatically too. Re-running
-- the same three inserts here (idempotent via on conflict do nothing)
-- keeps this migration correct even if it runs before/after any reseed.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.is_system_role and r.name in ('SUPER_ADMIN', 'ADMIN')
  and p.key in ('calls.manage', 'webhooks.manage')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.is_system_role and r.name = 'MANAGER'
  and p.key in ('calls.manage', 'webhooks.manage')
on conflict do nothing;
