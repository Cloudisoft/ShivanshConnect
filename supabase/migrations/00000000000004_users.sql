-- Phase 1: application users, 1:1 with auth.users

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email citext not null,
  full_name text not null default '',
  avatar_url text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_organization_id_idx on public.users (organization_id);
create unique index if not exists users_email_key on public.users (email);
create index if not exists users_status_idx on public.users (status);
create index if not exists users_created_at_idx on public.users (created_at);

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
  before update on public.users
  for each row
  execute function public.set_updated_at();

alter table public.users enable row level security;

-- Helper: the organization_id of the currently authenticated user.
-- SECURITY DEFINER + stable so it can be used cheaply inside RLS policies
-- without causing recursive RLS evaluation on public.users itself.
create or replace function public.current_user_organization_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select organization_id from public.users where id = auth.uid();
$$;

-- Helper: does the currently authenticated user hold the given permission key
-- anywhere within their organization (via user_roles -> role_permissions)?
-- Defined here as a forward-declared stub is not possible in SQL, so the
-- real definition lives in the roles/permissions migration; this file only
-- establishes current_user_organization_id which roles/users RLS depend on.
