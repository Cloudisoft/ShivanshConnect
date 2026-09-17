-- Phase 11: agent_evaluation_summary - a real GROUP BY/AVG aggregate over
-- call_evaluations, called via supabase.rpc() from
-- apps/backend/src/routes/agents.ts (GET /:id/evaluation-summary).
-- Deliberately NOT client-side computed from a full row dump - the
-- average overall score and the per-category averages (unnested from the
-- `scores` jsonb rubric) are both computed in Postgres.
--
-- organization_id is a required, non-optional filter baked directly into
-- the query, joined against calls.ai_agent_id so a call_evaluations row
-- can never be attributed to the wrong agent - same
-- structurally-impossible-to-leak-cross-tenant approach as
-- match_knowledge_chunks.
create or replace function public.agent_evaluation_summary(
  match_organization_id uuid,
  match_agent_id uuid,
  match_since timestamptz default (now() - interval '30 days')
)
returns table (
  call_count bigint,
  average_overall_score numeric,
  category_averages jsonb
)
language sql
stable
as $$
  with scoped as (
    select ce.overall_score, ce.scores
    from public.call_evaluations ce
    join public.calls c on c.id = ce.call_id
    where ce.organization_id = match_organization_id
      and c.organization_id = match_organization_id
      and c.ai_agent_id = match_agent_id
      and ce.evaluated_at >= match_since
  ),
  cats as (
    select kv.key, avg(kv.value::numeric) as avg_score
    from scoped, jsonb_each_text(scoped.scores) as kv
    group by kv.key
  )
  select
    (select count(*) from scoped) as call_count,
    (select round(avg(overall_score), 2) from scoped) as average_overall_score,
    coalesce((select jsonb_object_agg(key, round(avg_score, 2)) from cats), '{}'::jsonb) as category_averages;
$$;
