-- Phase 2: dnc_entries - Do Not Call suppression list.
--
-- Independent of any single `leads` row, because a number must be
-- suppressed even if it has never been imported as a lead yet (e.g. a
-- caller who calls in and asks to be put on the DNC list before any
-- lead record for them exists). organization_id is nullable: a null
-- means a platform-wide ("global") DNC entry; a non-null value scopes
-- the entry to one tenant. Two partial unique indexes enforce no
-- duplicate numbers within each scope (a plain unique index would treat
-- every null organization_id as distinct and allow duplicate globals).

create table if not exists public.dnc_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  phone_normalized text not null check (phone_normalized ~ '^\+[1-9]\d{9,14}$'),
  reason text,
  source text not null default 'manual' check (source in ('manual', 'caller_request', 'import')),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists dnc_entries_org_phone_key
  on public.dnc_entries (organization_id, phone_normalized) where organization_id is not null;
create unique index if not exists dnc_entries_global_phone_key
  on public.dnc_entries (phone_normalized) where organization_id is null;
create index if not exists dnc_entries_organization_id_idx on public.dnc_entries (organization_id);
create index if not exists dnc_entries_phone_normalized_idx on public.dnc_entries (phone_normalized);
create index if not exists dnc_entries_created_at_idx on public.dnc_entries (created_at);

alter table public.dnc_entries enable row level security;
