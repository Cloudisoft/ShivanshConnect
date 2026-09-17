-- Phase 3: ai_agent_improvements
--
-- Table only - stays empty until Phase 11's call evaluator populates it
-- by mining evaluated calls for recurring issues and suggesting prompt/
-- config changes. Phase 3 adds a read-only "Improvements" tab on the
-- agent detail page that queries this table and shows an honest empty
-- state; nothing in this phase writes rows here.

create table if not exists public.ai_agent_improvements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null references public.ai_agents (id) on delete cascade,

  issue text not null,
  evidence jsonb not null default '{}'::jsonb,
  suggested_change text not null,
  confidence numeric(4, 3) not null default 0 check (confidence >= 0 and confidence <= 1),
  frequency integer not null default 1 check (frequency >= 1),

  status text not null default 'detected' check (status in (
    'detected', 'under_review', 'approved', 'rejected', 'applied'
  )),
  affected_version_id uuid references public.ai_agent_versions (id) on delete set null,

  created_at timestamptz not null default now(),
  reviewed_by uuid references public.users (id) on delete set null,
  reviewed_at timestamptz
);

create index if not exists ai_agent_improvements_organization_id_idx on public.ai_agent_improvements (organization_id);
create index if not exists ai_agent_improvements_agent_id_idx on public.ai_agent_improvements (agent_id);
create index if not exists ai_agent_improvements_status_idx on public.ai_agent_improvements (status);
create index if not exists ai_agent_improvements_created_at_idx on public.ai_agent_improvements (created_at);

alter table public.ai_agent_improvements enable row level security;
