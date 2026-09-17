-- Phase 3: knowledge_bases, knowledge_documents, knowledge_chunks
--
-- Unified document pipeline for agent RAG (master spec sections 25/26/48).
-- A knowledge_base groups uploaded documents for an agent (or, later, a
-- campaign); each document is chunked and embedded into knowledge_chunks
-- for pgvector similarity search, strictly scoped to organization_id at
-- both the RLS layer (00000000000023) and in every application-code query
-- (apps/backend/src/routes/knowledgeBases.ts) - retrieval must never cross
-- organizations, see that route's dedicated cross-org test.
--
-- Embedding dimension: 1536, matching OpenAI's text-embedding-3-small
-- (apps/backend/src/lib/llm/openai.ts), the only embedding model this
-- build wires up. If a future phase adds a different embedding provider
-- with a different native dimension, that provider's adapter must project
-- into 1536 dims (or this column's dimension must change in a new
-- migration + a full re-embed) - dimensions cannot be mixed within one
-- vector column.

create extension if not exists "vector" with schema public;

create table if not exists public.knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid references public.ai_agents (id) on delete cascade,
  campaign_id uuid,

  name text not null check (char_length(name) between 1 and 200),

  created_at timestamptz not null default now()
);

create index if not exists knowledge_bases_organization_id_idx on public.knowledge_bases (organization_id);
create index if not exists knowledge_bases_agent_id_idx on public.knowledge_bases (agent_id);
create index if not exists knowledge_bases_created_at_idx on public.knowledge_bases (created_at);

alter table public.knowledge_bases enable row level security;

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_bases (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  file_name text not null,
  file_type text not null check (file_type in ('pdf', 'docx', 'txt', 'csv', 'md')),
  -- No object storage yet (same synthetic-locator approach as Phase 2's
  -- import_jobs.file_storage_path) - the file is parsed in-memory on
  -- upload and never persisted to disk/S3.
  storage_path text not null,

  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  size_bytes bigint not null default 0 check (size_bytes >= 0),

  uploaded_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text
);

create index if not exists knowledge_documents_kb_id_idx on public.knowledge_documents (knowledge_base_id);
create index if not exists knowledge_documents_organization_id_idx on public.knowledge_documents (organization_id);
create index if not exists knowledge_documents_status_idx on public.knowledge_documents (status);
create index if not exists knowledge_documents_created_at_idx on public.knowledge_documents (created_at);

alter table public.knowledge_documents enable row level security;

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  embedding public.vector(1536),

  created_at timestamptz not null default now()
);

create unique index if not exists knowledge_chunks_document_chunk_key
  on public.knowledge_chunks (document_id, chunk_index);
create index if not exists knowledge_chunks_document_id_idx on public.knowledge_chunks (document_id);
create index if not exists knowledge_chunks_organization_id_idx on public.knowledge_chunks (organization_id);

-- ivfflat requires a non-empty table to train against well, but is safe
-- to create against an empty one (Postgres just uses 1 list) - it will
-- get more effective as documents are added. Cosine distance matches
-- OpenAI's embedding space.
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

alter table public.knowledge_chunks enable row level security;
