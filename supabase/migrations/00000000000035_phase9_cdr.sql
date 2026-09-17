-- Phase 9: CDR, transcripts, recordings, AI call summaries (master spec
-- sections 21, 22, 23-partial [call summaries only - the full evaluator is
-- Phase 11]).
--
-- Four new tables:
--   call_transcripts          - one row per call, full_text for search
--   call_transcript_segments  - real per-utterance rows (speaker/timestamp/
--                                text), so the spec's "00:00 AI: Hello.../
--                                00:04 Caller: Hi..." format and search-
--                                within-transcript both work
--   call_recordings           - our own durable copy of the provider's
--                                recording (storage_path), never just a
--                                passthrough of the provider's own
--                                possibly-ephemeral URL
--   call_summaries            - the LLM-generated structured summary
--                                (spec section 23's exact field list);
--                                simply absent when no LLM is configured -
--                                never a fabricated summary
--
-- Plus `exports` - background CDR export jobs (spec sections 21/65).
--
-- cdr.view / cdr.export permissions already exist in the Phase 1 seed
-- catalog (00000000000009_seed_roles_permissions.sql) - nothing new to
-- seed here.

-- ---------------------------------------------------------------------
-- call_transcripts
-- ---------------------------------------------------------------------
create table if not exists public.call_transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  full_text text,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  failure_reason text,
  source_url text,
  -- Generated tsvector column + GIN index: the spec's "search within
  -- transcript" requirement, scoped per-org via the accompanying
  -- organization_id filter every query applies (never relies on the index
  -- alone for isolation - see routes/cdr.ts).
  full_text_tsv tsvector generated always as (to_tsvector('english', coalesce(full_text, ''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists call_transcripts_call_id_key on public.call_transcripts (call_id);
create index if not exists call_transcripts_organization_id_idx on public.call_transcripts (organization_id);
create index if not exists call_transcripts_status_idx on public.call_transcripts (status);
create index if not exists call_transcripts_full_text_tsv_idx on public.call_transcripts using gin (full_text_tsv);

drop trigger if exists call_transcripts_set_updated_at on public.call_transcripts;
create trigger call_transcripts_set_updated_at
  before update on public.call_transcripts
  for each row execute function public.set_updated_at();

alter table public.call_transcripts enable row level security;

-- ---------------------------------------------------------------------
-- call_transcript_segments - real per-utterance rows.
-- ---------------------------------------------------------------------
create table if not exists public.call_transcript_segments (
  id uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references public.call_transcripts (id) on delete cascade,
  call_id uuid not null references public.calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  speaker text not null check (speaker in ('ai', 'caller')),
  segment_index integer not null,
  start_ms integer not null default 0,
  end_ms integer,
  text text not null,
  text_tsv tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored,
  created_at timestamptz not null default now()
);

create unique index if not exists call_transcript_segments_transcript_index_key
  on public.call_transcript_segments (transcript_id, segment_index);
create index if not exists call_transcript_segments_transcript_id_idx on public.call_transcript_segments (transcript_id);
create index if not exists call_transcript_segments_call_id_idx on public.call_transcript_segments (call_id);
create index if not exists call_transcript_segments_organization_id_idx on public.call_transcript_segments (organization_id);
create index if not exists call_transcript_segments_text_tsv_idx on public.call_transcript_segments using gin (text_tsv);

alter table public.call_transcript_segments enable row level security;

-- ---------------------------------------------------------------------
-- call_recordings - our own durable copy, per spec 22's "never expose
-- private storage credentials, generate signed temporary download URLs"
-- intent, which implies we own the durable copy rather than re-exposing
-- the provider's own (possibly time-limited) recording URL forever.
-- ---------------------------------------------------------------------
create table if not exists public.call_recordings (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider_recording_url text,
  storage_path text,
  format text check (format is null or format in ('mp3', 'wav')),
  duration_seconds integer,
  size_bytes bigint,
  status text not null default 'pending' check (status in ('pending', 'downloading', 'ready', 'failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists call_recordings_call_id_key on public.call_recordings (call_id);
create index if not exists call_recordings_organization_id_idx on public.call_recordings (organization_id);
create index if not exists call_recordings_status_idx on public.call_recordings (status);

drop trigger if exists call_recordings_set_updated_at on public.call_recordings;
create trigger call_recordings_set_updated_at
  before update on public.call_recordings
  for each row execute function public.set_updated_at();

alter table public.call_recordings enable row level security;

-- ---------------------------------------------------------------------
-- call_summaries - spec section 23's exact field list. Only created when
-- an LLM provider is actually configured and a real summary was
-- generated - never a placeholder row.
-- ---------------------------------------------------------------------
create table if not exists public.call_summaries (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  summary text not null,
  key_points jsonb not null default '[]'::jsonb,
  customer_intent text,
  objections jsonb,
  questions jsonb,
  next_action text,
  outcome text,
  llm_provider text not null,
  llm_model text not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists call_summaries_call_id_key on public.call_summaries (call_id);
create index if not exists call_summaries_organization_id_idx on public.call_summaries (organization_id);

alter table public.call_summaries enable row level security;

-- ---------------------------------------------------------------------
-- exports - background CDR export jobs (spec sections 21/65). Never
-- generated synchronously - see services/cdrExport.ts.
-- ---------------------------------------------------------------------
create table if not exists public.exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type text not null check (type in ('cdr_csv', 'cdr_xlsx')),
  filters jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  file_storage_path text,
  row_count integer,
  failure_reason text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists exports_organization_id_idx on public.exports (organization_id);
create index if not exists exports_status_idx on public.exports (status);
create index if not exists exports_created_at_idx on public.exports (created_at);

alter table public.exports enable row level security;

-- ---------------------------------------------------------------------
-- search_call_transcripts: full-text search across call_transcripts,
-- scoped to one organization (a required, non-optional argument - the
-- same structural cross-tenant-isolation pattern as
-- match_knowledge_chunks in 00000000000023). Ranked with ts_rank.
-- ---------------------------------------------------------------------
create or replace function public.search_call_transcripts(
  search_query text,
  match_organization_id uuid,
  match_count int default 20,
  match_offset int default 0
)
returns table (
  transcript_id uuid,
  call_id uuid,
  full_text text,
  rank float8
)
language sql
stable
as $$
  select
    ct.id as transcript_id,
    ct.call_id,
    ct.full_text,
    ts_rank(ct.full_text_tsv, plainto_tsquery('english', search_query)) as rank
  from public.call_transcripts ct
  where ct.organization_id = match_organization_id
    and ct.status = 'ready'
    and ct.full_text_tsv @@ plainto_tsquery('english', search_query)
  order by rank desc
  limit greatest(match_count, 0)
  offset greatest(match_offset, 0);
$$;
