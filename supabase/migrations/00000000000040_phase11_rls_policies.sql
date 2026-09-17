-- Phase 11: Row Level Security for call_evaluations, plus the
-- insert/update policies ai_agent_improvements never got in Phase 3
-- (it was read-only/empty until now). Same defense-in-depth approach as
-- every prior phase: the backend does its real reads/writes with the
-- service-role key (which bypasses RLS) and enforces org-scoping + the
-- `agents.manage` permission explicitly in application code
-- (services/evaluateCall.ts, services/aggregateAgentImprovements.ts,
-- routes/agentImprovements.ts, routes/calls.ts, routes/agents.ts) - these
-- policies are the second line of defense for any code path that ever
-- queries with a user's own JWT.

drop policy if exists call_evaluations_select on public.call_evaluations;
create policy call_evaluations_select on public.call_evaluations
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists call_evaluations_insert on public.call_evaluations;
create policy call_evaluations_insert on public.call_evaluations
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists call_evaluations_update on public.call_evaluations;
create policy call_evaluations_update on public.call_evaluations
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

-- ai_agent_improvements - insert/update policies, additive to the
-- select-only policy 00000000000022 already defined.
drop policy if exists ai_agent_improvements_insert on public.ai_agent_improvements;
create policy ai_agent_improvements_insert on public.ai_agent_improvements
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists ai_agent_improvements_update on public.ai_agent_improvements;
create policy ai_agent_improvements_update on public.ai_agent_improvements
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  )
  with check (organization_id = public.current_user_organization_id());
