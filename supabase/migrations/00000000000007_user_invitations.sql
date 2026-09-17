-- Phase 1: user_invitations

create table if not exists public.user_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email citext not null,
  role_id uuid not null references public.roles (id) on delete restrict,
  invited_by uuid references public.users (id) on delete set null,
  token uuid not null default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

create index if not exists user_invitations_organization_id_idx on public.user_invitations (organization_id);
create index if not exists user_invitations_email_idx on public.user_invitations (email);
create unique index if not exists user_invitations_token_key on public.user_invitations (token);
create index if not exists user_invitations_status_idx on public.user_invitations (status);
create index if not exists user_invitations_created_at_idx on public.user_invitations (created_at);

-- Only one live (pending, unexpired) invitation per org+email at a time.
create unique index if not exists user_invitations_org_email_pending_key
  on public.user_invitations (organization_id, email)
  where status = 'pending';

alter table public.user_invitations enable row level security;
