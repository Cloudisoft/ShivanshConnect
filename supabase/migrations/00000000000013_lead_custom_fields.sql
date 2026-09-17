-- Phase 2: lead_custom_fields - per-organization catalog of the custom
-- field keys an org is allowed to store on a lead's `custom_fields` jsonb
-- blob. Imports validate uploaded column mappings against this table so
-- an org can't accidentally scatter arbitrarily-named keys across leads.

create table if not exists public.lead_custom_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  field_label text not null check (char_length(field_label) between 1 and 200),
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date', 'boolean')),
  created_at timestamptz not null default now()
);

create unique index if not exists lead_custom_fields_org_key_key
  on public.lead_custom_fields (organization_id, field_key);
create index if not exists lead_custom_fields_organization_id_idx
  on public.lead_custom_fields (organization_id);

alter table public.lead_custom_fields enable row level security;
