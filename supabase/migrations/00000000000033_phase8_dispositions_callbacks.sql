-- Phase 8: call state machine (no schema change - Phase 6/7 already
-- defined the full CALL_STATUSES enum this phase's state machine
-- enforces; see apps/backend/src/lib/callStateMachine.ts), the
-- deterministic disposition engine, retry engine formalization (no new
-- schema - see services/retryEngine.ts), and the callback scheduler.
--
-- Master spec sections 17, 20, 50, 51, 52, 53.

-- ---------------------------------------------------------------------
-- dispositions - system defaults (organization_id null) plus per-org
-- custom dispositions. `code` is the stable machine key the deterministic
-- engine (services/dispositionEngine.ts) and the retry engine key off of;
-- `name` is the human label shown in the UI. A partial unique index keeps
-- system codes globally unique and per-org codes unique within that org,
-- exactly mirroring the dnc_entries global/org-scoped pattern from Phase 2.
-- ---------------------------------------------------------------------
create table if not exists public.dispositions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  code text not null,
  name text not null check (char_length(name) between 1 and 100),
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists dispositions_system_code_key
  on public.dispositions (code) where organization_id is null;
create unique index if not exists dispositions_org_code_key
  on public.dispositions (organization_id, code) where organization_id is not null;
create index if not exists dispositions_organization_id_idx on public.dispositions (organization_id);

alter table public.dispositions enable row level security;

insert into public.dispositions (organization_id, code, name, is_system) values
  (null, 'CALL_CONNECTED', 'Call Connected', true),
  (null, 'DISCONNECTED', 'Disconnected', true),
  (null, 'DNC', 'DNC', true),
  (null, 'ANSWERING_MACHINE', 'Answering Machine', true),
  (null, 'VOICEMAIL', 'Voicemail', true),
  (null, 'NOT_INTERESTED', 'Not Interested', true),
  (null, 'HUNG_UP', 'Hung Up', true),
  (null, 'TRANSFERRED', 'Transferred', true),
  (null, 'CALL_DISCONNECTED_IN_TRANSFER', 'Call Disconnected in Transfer', true)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- call_dispositions - EXACTLY one primary disposition per call
-- (UNIQUE (call_id)), per spec. disposition_source distinguishes the
-- deterministic engine's own assignment from a supervisor's manual
-- override (PATCH /api/v1/calls/:id/disposition) - the override is a
-- legitimate correction path, never a way to bypass the engine's default
-- behavior (the engine still runs first, every time, on every terminal
-- call event).
-- ---------------------------------------------------------------------
create table if not exists public.call_dispositions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  disposition_id uuid not null references public.dispositions (id) on delete restrict,
  disposition_source text not null default 'engine' check (disposition_source in ('engine', 'manual')),
  disposition_confidence numeric(4, 3) check (disposition_confidence is null or (disposition_confidence >= 0 and disposition_confidence <= 1)),
  disposition_reason text,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.users (id) on delete set null
);

create unique index if not exists call_dispositions_call_id_key on public.call_dispositions (call_id);
create index if not exists call_dispositions_organization_id_idx on public.call_dispositions (organization_id);
create index if not exists call_dispositions_disposition_id_idx on public.call_dispositions (disposition_id);

alter table public.call_dispositions enable row level security;

-- ---------------------------------------------------------------------
-- callbacks - spec sections 17/53. scheduled_at is timestamptz (explicit
-- timezone per the value itself); `timezone` is stored alongside purely
-- for display (the IANA zone the scheduling user/AI meant "3pm" in).
-- assigned_to is a users.id OR the literal string 'ai' (checked in
-- application code, not a FK, since 'ai' is not a real user row).
-- ---------------------------------------------------------------------
create table if not exists public.callbacks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  lead_id uuid not null references public.leads (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9]\d{6,14}$'),
  scheduled_at timestamptz not null,
  timezone text not null default 'America/New_York',
  reason text,
  notes text,
  assigned_to text,
  status text not null default 'scheduled' check (status in ('scheduled', 'pending', 'calling', 'completed', 'cancelled', 'failed')),
  source_call_id uuid references public.calls (id) on delete set null,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists callbacks_organization_id_idx on public.callbacks (organization_id);
create index if not exists callbacks_campaign_id_idx on public.callbacks (campaign_id);
create index if not exists callbacks_lead_id_idx on public.callbacks (lead_id);
create index if not exists callbacks_status_idx on public.callbacks (status);
-- Calendar/date-range queries and the "due callbacks" scan both filter on
-- (organization_id, status, scheduled_at) - one composite index covers both.
create index if not exists callbacks_dispatch_idx on public.callbacks (organization_id, status, scheduled_at);

drop trigger if exists callbacks_set_updated_at on public.callbacks;
create trigger callbacks_set_updated_at
  before update on public.callbacks
  for each row execute function public.set_updated_at();

alter table public.callbacks enable row level security;

-- ---------------------------------------------------------------------
-- Permissions: callbacks.manage (no exact match in the Phase 1 catalog).
-- Granted to SUPER_ADMIN/ADMIN (already get everything), MANAGER and
-- AGENT per the task brief.
-- ---------------------------------------------------------------------
insert into public.permissions (key, description, category)
values ('callbacks.manage', 'Create, view, reschedule and cancel callbacks', 'calls')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.is_system_role and r.name in ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'AGENT')
  and p.key = 'callbacks.manage'
on conflict do nothing;
