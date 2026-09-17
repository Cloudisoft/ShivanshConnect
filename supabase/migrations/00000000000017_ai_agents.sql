-- Phase 3: ai_agents
--
-- Per master spec sections 25/26/46. An agent is a named AI persona
-- ("Sales agent", "Front desk") that can be attached to campaigns in a
-- later phase. Its actual behavior (prompt, personality, LLM settings,
-- voice) lives in an immutable, versioned ai_agent_versions row - see
-- 00000000000018 - so publishing a new configuration never rewrites
-- history. current_version_id is nullable because a freshly-created
-- agent has no published version yet (it starts in a draft version that
-- has never been published).

create table if not exists public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name text not null check (char_length(name) between 1 and 200),
  description text,
  role text not null check (role in (
    'sales_agent', 'support_agent', 'front_desk', 'receptionist', 'manager',
    'escalation_specialist', 'appointment_setter', 'lead_qualification_agent', 'custom'
  )),
  status text not null default 'draft' check (status in ('draft', 'active', 'inactive')),

  -- FK added via alter table below (not inline) because
  -- ai_agent_versions.agent_id also references this table - the circular
  -- reference is resolved by creating ai_agents first without the FK,
  -- then adding it once ai_agent_versions exists in the next migration.
  current_version_id uuid,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ai_agents_org_name_key on public.ai_agents (organization_id, name);
create index if not exists ai_agents_organization_id_idx on public.ai_agents (organization_id);
create index if not exists ai_agents_status_idx on public.ai_agents (status);
create index if not exists ai_agents_created_at_idx on public.ai_agents (created_at);

drop trigger if exists ai_agents_set_updated_at on public.ai_agents;
create trigger ai_agents_set_updated_at
  before update on public.ai_agents
  for each row
  execute function public.set_updated_at();

alter table public.ai_agents enable row level security;
