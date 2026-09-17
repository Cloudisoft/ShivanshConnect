-- Phase 3: Row Level Security policies for ai_agents, ai_agent_versions,
-- ai_agent_improvements, scripts, knowledge_bases, knowledge_documents,
-- knowledge_chunks.
--
-- Same approach as 00000000000008/00000000000016: the backend does its
-- actual reads/writes with the service-role key and enforces
-- organization-scoping + the `agents.manage` permission explicitly in
-- application code (apps/backend/src/routes/agents.ts,
-- scripts.ts, knowledgeBases.ts). These policies are the second line of
-- defense for any code path that ever queries with a user's own JWT, and
-- are what actually guarantees knowledge_chunks retrieval can never cross
-- organization_id even if application code had a bug.

-- ---------------------------------------------------------------------
-- ai_agents
-- ---------------------------------------------------------------------
drop policy if exists ai_agents_select on public.ai_agents;
create policy ai_agents_select on public.ai_agents
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists ai_agents_insert on public.ai_agents;
create policy ai_agents_insert on public.ai_agents
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists ai_agents_update on public.ai_agents;
create policy ai_agents_update on public.ai_agents
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists ai_agents_delete on public.ai_agents;
create policy ai_agents_delete on public.ai_agents
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

-- ---------------------------------------------------------------------
-- ai_agent_versions
-- ---------------------------------------------------------------------
drop policy if exists ai_agent_versions_select on public.ai_agent_versions;
create policy ai_agent_versions_select on public.ai_agent_versions
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists ai_agent_versions_insert on public.ai_agent_versions;
create policy ai_agent_versions_insert on public.ai_agent_versions
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists ai_agent_versions_update on public.ai_agent_versions;
create policy ai_agent_versions_update on public.ai_agent_versions
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  )
  with check (organization_id = public.current_user_organization_id());

-- ---------------------------------------------------------------------
-- ai_agent_improvements (read-only from the app in Phase 3 - insert is
-- reserved for the Phase 11 evaluator, running under the service-role
-- key, which bypasses RLS entirely; no authenticated-role insert policy
-- is defined here on purpose)
-- ---------------------------------------------------------------------
drop policy if exists ai_agent_improvements_select on public.ai_agent_improvements;
create policy ai_agent_improvements_select on public.ai_agent_improvements
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

-- ---------------------------------------------------------------------
-- scripts
-- ---------------------------------------------------------------------
drop policy if exists scripts_select on public.scripts;
create policy scripts_select on public.scripts
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists scripts_insert on public.scripts;
create policy scripts_insert on public.scripts
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists scripts_update on public.scripts;
create policy scripts_update on public.scripts
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists scripts_delete on public.scripts;
create policy scripts_delete on public.scripts
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

-- ---------------------------------------------------------------------
-- knowledge_bases
-- ---------------------------------------------------------------------
drop policy if exists knowledge_bases_select on public.knowledge_bases;
create policy knowledge_bases_select on public.knowledge_bases
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists knowledge_bases_insert on public.knowledge_bases;
create policy knowledge_bases_insert on public.knowledge_bases
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists knowledge_bases_delete on public.knowledge_bases;
create policy knowledge_bases_delete on public.knowledge_bases
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

-- ---------------------------------------------------------------------
-- knowledge_documents
-- ---------------------------------------------------------------------
drop policy if exists knowledge_documents_select on public.knowledge_documents;
create policy knowledge_documents_select on public.knowledge_documents
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists knowledge_documents_insert on public.knowledge_documents;
create policy knowledge_documents_insert on public.knowledge_documents
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists knowledge_documents_update on public.knowledge_documents;
create policy knowledge_documents_update on public.knowledge_documents
  for update
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  )
  with check (organization_id = public.current_user_organization_id());

drop policy if exists knowledge_documents_delete on public.knowledge_documents;
create policy knowledge_documents_delete on public.knowledge_documents
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

-- ---------------------------------------------------------------------
-- knowledge_chunks - the tenant-isolation-critical table. select is the
-- path RAG retrieval uses; even if application code forgot an
-- organization_id filter, this policy alone prevents cross-org reads.
-- ---------------------------------------------------------------------
drop policy if exists knowledge_chunks_select on public.knowledge_chunks;
create policy knowledge_chunks_select on public.knowledge_chunks
  for select
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists knowledge_chunks_insert on public.knowledge_chunks;
create policy knowledge_chunks_insert on public.knowledge_chunks
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );

drop policy if exists knowledge_chunks_delete on public.knowledge_chunks;
create policy knowledge_chunks_delete on public.knowledge_chunks
  for delete
  using (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('agents.manage')
  );
