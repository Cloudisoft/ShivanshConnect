-- Phase 3: ai_agent_versions
--
-- Every configuration change to an agent creates a new, immutable version
-- row (never mutates a previously-published one) - draft -> published ->
-- (superseded, archived on next publish) or restore (creates a NEW draft
-- copying an old version's config). ai_agents.current_version_id points
-- at whichever version is currently live for calls.
--
-- personality/transfer_rules/call_ending_rules are jsonb per the master
-- spec's preset-combination model (tone, personality traits array,
-- behavior traits array - see packages/shared/src/agent.ts for the
-- concrete preset catalog used by the frontend wizard).
--
-- voice_id is a bare text column, not yet a foreign key: the `voices`
-- table doesn't exist until Phase 4. That phase's migration is expected
-- to add `alter table ai_agent_versions add constraint ... foreign key
-- (voice_id) references voices (id)` once the table exists - the column
-- itself is created now so Phase 3's agent config UI can already store a
-- (currently unvalidated) voice selection.

create table if not exists public.ai_agent_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.ai_agents (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  version_number integer not null check (version_number >= 1),

  -- { tone: string, personality_traits: string[], behavior_traits: string[] }
  personality jsonb not null default '{}'::jsonb,
  language text not null default 'en-US',
  accent text,
  greeting_template text not null default '',
  system_prompt text not null default '',
  fallback_behavior text,
  -- { on_no_match: string, transfer_to: string | null, conditions: [...] }
  transfer_rules jsonb not null default '{}'::jsonb,
  -- { max_call_duration_seconds: number | null, end_phrases: string[], ... }
  call_ending_rules jsonb not null default '{}'::jsonb,

  llm_provider text not null default 'openai',
  llm_model text not null default 'gpt-4o-mini',
  llm_temperature numeric(3, 2) not null default 0.70 check (llm_temperature >= 0 and llm_temperature <= 2),
  llm_max_tokens integer not null default 800 check (llm_max_tokens > 0),

  voice_id text,

  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists ai_agent_versions_agent_version_key
  on public.ai_agent_versions (agent_id, version_number);
create index if not exists ai_agent_versions_agent_id_idx on public.ai_agent_versions (agent_id);
create index if not exists ai_agent_versions_organization_id_idx on public.ai_agent_versions (organization_id);
create index if not exists ai_agent_versions_status_idx on public.ai_agent_versions (status);
create index if not exists ai_agent_versions_created_at_idx on public.ai_agent_versions (created_at);

alter table public.ai_agent_versions enable row level security;

-- Now that ai_agent_versions exists, wire up the FK from ai_agents that
-- 00000000000017 deferred.
alter table public.ai_agents
  drop constraint if exists ai_agents_current_version_id_fkey;
alter table public.ai_agents
  add constraint ai_agents_current_version_id_fkey
  foreign key (current_version_id) references public.ai_agent_versions (id) on delete set null;
