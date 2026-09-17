-- Phase 1: organization_settings (jsonb settings bag for forward extensibility)

create table if not exists public.organization_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists organization_settings_org_id_key
  on public.organization_settings (organization_id);

drop trigger if exists organization_settings_set_updated_at on public.organization_settings;
create trigger organization_settings_set_updated_at
  before update on public.organization_settings
  for each row
  execute function public.set_updated_at();

alter table public.organization_settings enable row level security;
