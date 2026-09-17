-- Phase 1: roles, permissions, role_permissions, user_roles

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  is_system_role boolean not null default false,
  created_at timestamptz not null default now(),
  -- system roles have organization_id null and a globally unique name;
  -- custom roles are scoped to one org.
  constraint roles_system_role_no_org check (
    (is_system_role and organization_id is null) or (not is_system_role and organization_id is not null)
  )
);

create unique index if not exists roles_system_name_key
  on public.roles (name) where is_system_role;
create unique index if not exists roles_org_name_key
  on public.roles (organization_id, name) where not is_system_role;
create index if not exists roles_organization_id_idx on public.roles (organization_id);

alter table public.roles enable row level security;

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  description text not null default '',
  category text not null default ''
);

create unique index if not exists permissions_key_key on public.permissions (key);
create index if not exists permissions_category_idx on public.permissions (category);

alter table public.permissions enable row level security;

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

create index if not exists role_permissions_role_id_idx on public.role_permissions (role_id);
create index if not exists role_permissions_permission_id_idx on public.role_permissions (permission_id);

alter table public.role_permissions enable row level security;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, role_id)
);

create index if not exists user_roles_user_id_idx on public.user_roles (user_id);
create index if not exists user_roles_role_id_idx on public.user_roles (role_id);
create index if not exists user_roles_organization_id_idx on public.user_roles (organization_id);

alter table public.user_roles enable row level security;

-- Helper: does the current user hold the given permission key, within their org?
create or replace function public.current_user_has_permission(perm_key text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
    where ur.user_id = auth.uid()
      and p.key = perm_key
  );
$$;
