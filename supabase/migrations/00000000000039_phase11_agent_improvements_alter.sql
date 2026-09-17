-- Phase 11: extends Phase 3's ai_agent_improvements table (created empty
-- in 00000000000019) with the two columns this phase's real evaluator
-- needs to trace a suggestion back to real evidence, and an updated_at
-- for the human-in-the-loop status workflow.
--
-- source_call_id / source_evaluation_id point at the MOST RECENT call
-- and evaluation that surfaced or reinforced this issue - the full
-- history of every contributing call lives in the `evidence` jsonb
-- column (services/aggregateAgentImprovements.ts appends to it on every
-- recurrence), so nothing here is lost, this is just a fast single-value
-- pointer for the frontend's "view the source call" deep link.
alter table public.ai_agent_improvements
  add column if not exists source_call_id uuid references public.calls (id) on delete set null,
  add column if not exists source_evaluation_id uuid references public.call_evaluations (id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists ai_agent_improvements_source_call_id_idx on public.ai_agent_improvements (source_call_id);

drop trigger if exists ai_agent_improvements_set_updated_at on public.ai_agent_improvements;
create trigger ai_agent_improvements_set_updated_at
  before update on public.ai_agent_improvements
  for each row execute function public.set_updated_at();
