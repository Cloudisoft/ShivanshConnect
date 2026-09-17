-- Phase 11: AI call evaluator (master spec section 24).
--
-- One row per evaluated call, holding the full structured rubric score
-- (17 sub-scores, per spec section 24's exact category list) plus the
-- qualitative findings the LLM extracts from the real transcript. A call
-- that never got a ready transcript (failed/very short/cancelled calls)
-- never gets a row here - see services/evaluateCall.ts's header comment
-- for the exact skip conditions. Never fabricated: a row only exists when
-- a real LLM call actually produced a parseable structured result.
create table if not exists public.call_evaluations (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  overall_score numeric(5, 2) not null check (overall_score >= 0 and overall_score <= 100),
  -- Per spec section 24's exact rubric - each sub-score 0-100, stored as a
  -- single jsonb object rather than 17 individual columns so the rubric
  -- can grow without a migration every time, while still being fully
  -- queryable via jsonb operators (see the evaluation-summary aggregate
  -- function in 00000000000041).
  scores jsonb not null default '{}'::jsonb,

  what_went_well jsonb not null default '[]'::jsonb,
  what_went_poorly jsonb not null default '[]'::jsonb,
  missed_opportunities jsonb not null default '[]'::jsonb,
  incorrect_statements jsonb not null default '[]'::jsonb,
  customer_objections jsonb not null default '[]'::jsonb,
  recommended_improvement text,

  llm_provider text not null,
  llm_model text not null,
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists call_evaluations_call_id_key on public.call_evaluations (call_id);
create index if not exists call_evaluations_organization_id_idx on public.call_evaluations (organization_id);
create index if not exists call_evaluations_evaluated_at_idx on public.call_evaluations (evaluated_at);

alter table public.call_evaluations enable row level security;
