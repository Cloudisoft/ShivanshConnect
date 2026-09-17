-- Phase 3: match_knowledge_chunks - pgvector cosine similarity search,
-- called via supabase.rpc() from
-- apps/backend/src/routes/agents.ts (POST /:id/knowledge/search).
--
-- organization_id is a required, non-optional filter baked directly into
-- the query (not left to the caller to remember) - this is what makes
-- cross-tenant leakage structurally impossible even if application code
-- passed a wrong/guessed id for anything else. agent_id further narrows
-- to the knowledge base(s) attached to a specific agent when provided.

create or replace function public.match_knowledge_chunks(
  query_embedding public.vector(1536),
  match_organization_id uuid,
  match_agent_id uuid default null,
  match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  similarity float8
)
language sql
stable
as $$
  select
    kc.id,
    kc.document_id,
    kc.chunk_index,
    kc.content,
    1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_documents kd on kd.id = kc.document_id
  join public.knowledge_bases kb on kb.id = kd.knowledge_base_id
  where kc.organization_id = match_organization_id
    and kd.organization_id = match_organization_id
    and kb.organization_id = match_organization_id
    and (match_agent_id is null or kb.agent_id = match_agent_id)
    and kc.embedding is not null
  order by kc.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;
