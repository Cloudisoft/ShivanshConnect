-- Phase 3: scripts
--
-- Call scripts with {{variable}} placeholders (first_name, last_name,
-- company, phone, email, custom_field.*), usable standalone, attached to
-- an agent, or (once campaigns exist - Phase 7) attached to a campaign.
-- campaign_id has no FK yet since the `campaigns` table doesn't exist
-- until Phase 7; that phase's migration adds the constraint the same way
-- Phase 4 adds ai_agent_versions.voice_id's FK.

create table if not exists public.scripts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid references public.ai_agents (id) on delete set null,
  campaign_id uuid,

  name text not null check (char_length(name) between 1 and 200),
  content text not null default '',
  version integer not null default 1 check (version >= 1),
  source text not null default 'editor' check (source in ('editor', 'upload', 'template')),

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scripts_organization_id_idx on public.scripts (organization_id);
create index if not exists scripts_agent_id_idx on public.scripts (agent_id);
create index if not exists scripts_campaign_id_idx on public.scripts (campaign_id);
create index if not exists scripts_created_at_idx on public.scripts (created_at);

drop trigger if exists scripts_set_updated_at on public.scripts;
create trigger scripts_set_updated_at
  before update on public.scripts
  for each row
  execute function public.set_updated_at();

alter table public.scripts enable row level security;
