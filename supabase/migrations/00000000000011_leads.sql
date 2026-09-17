-- Phase 2: leads
--
-- lead_list_id is a nullable "primary list" convenience pointer (e.g. the
-- list a lead was originally imported into); actual list membership -
-- including a lead belonging to more than one list - is tracked
-- separately in lead_list_members (00000000000012). phone_normalized is
-- strict E.164 (see apps/backend/src/lib/phone.ts) and is unique per
-- organization so the same contact is never duplicated within a tenant.
--
-- `status` seeds the full Phase 51 lead state machine now, even though
-- nothing in this phase drives leads through it yet (no dialer exists
-- until later phases) - every status a lead can ever reach is a valid
-- value from day one so no later migration has to widen this constraint.

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_list_id uuid references public.lead_lists (id) on delete set null,

  first_name text not null default '',
  last_name text not null default '',
  company text,

  phone_original text not null,
  phone_normalized text not null,
  country_code text not null default 'US',

  email citext,
  address text,
  city text,
  state text,
  zip text,
  country text not null default 'US',

  status text not null default 'NEW' check (status in (
    'NEW', 'QUEUED', 'CALLED', 'CONNECTED', 'VOICEMAIL', 'NO_ANSWER', 'BUSY',
    'DNC', 'CALLBACK', 'TRANSFERRED', 'COMPLETED', 'FAILED'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  last_called_at timestamptz,
  last_disposition text,
  next_callback_at timestamptz,

  is_dnc boolean not null default false,
  dnc_reason text,

  custom_fields jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint leads_phone_normalized_format check (phone_normalized ~ '^\+[1-9]\d{9,14}$')
);

create unique index if not exists leads_org_phone_key on public.leads (organization_id, phone_normalized);
create index if not exists leads_organization_id_idx on public.leads (organization_id);
create index if not exists leads_phone_normalized_idx on public.leads (phone_normalized);
create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_lead_list_id_idx on public.leads (lead_list_id);
create index if not exists leads_created_at_idx on public.leads (created_at);
create index if not exists leads_is_dnc_idx on public.leads (is_dnc);
create index if not exists leads_org_search_idx on public.leads (organization_id, last_name, first_name);

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row
  execute function public.set_updated_at();

alter table public.leads enable row level security;
