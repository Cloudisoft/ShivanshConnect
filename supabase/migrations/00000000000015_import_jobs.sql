-- Phase 2: import_jobs + import_job_rows - async CSV/XLSX lead import.
--
-- Per master spec section 64. There is no queue/worker infra yet
-- (Redis/BullMQ lands in the deployment phase), so
-- apps/backend/src/services/importLeads.ts processes a job on the
-- backend process itself via setImmediate - see that file's header
-- comment for how a future BullMQ worker picks this up unchanged.
--
-- import_job_rows holds the parsed + validated outcome of every row in
-- the uploaded file (not named in the spec's own table list, but
-- required to make "parse once, preview, then commit" real: without it,
-- a commit call would have to silently re-read and re-parse the
-- original file, and an error-rows download would have nothing to
-- read from). Rows are written once during validation and are only
-- updated with their resulting lead_id at commit time.

create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_list_id uuid not null references public.lead_lists (id) on delete cascade,

  file_name text not null,
  -- Phase 2 has no object storage provisioned yet, so the uploaded file
  -- is parsed in-memory on receipt and never persisted to disk/S3; this
  -- column records a synthetic locator (`memory:<job_id>/<file_name>`)
  -- so the schema already matches later phases that add real storage.
  file_storage_path text not null,

  status text not null default 'pending' check (status in (
    'pending', 'parsing', 'validating', 'ready_for_review', 'committing', 'completed', 'failed'
  )),
  column_mapping jsonb not null default '{}'::jsonb,
  error_message text,

  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  invalid_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  dnc_rows integer not null default 0,
  imported_rows integer not null default 0,

  error_report_path text,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists import_jobs_organization_id_idx on public.import_jobs (organization_id);
create index if not exists import_jobs_lead_list_id_idx on public.import_jobs (lead_list_id);
create index if not exists import_jobs_status_idx on public.import_jobs (status);
create index if not exists import_jobs_created_at_idx on public.import_jobs (created_at);

drop trigger if exists import_jobs_set_updated_at on public.import_jobs;
create trigger import_jobs_set_updated_at
  before update on public.import_jobs
  for each row
  execute function public.set_updated_at();

alter table public.import_jobs enable row level security;

create table if not exists public.import_job_rows (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references public.import_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  result text not null check (result in ('valid', 'invalid', 'duplicate', 'dnc')),
  error_message text,
  phone_normalized text,
  lead_id uuid references public.leads (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists import_job_rows_import_job_id_idx on public.import_job_rows (import_job_id);
create index if not exists import_job_rows_organization_id_idx on public.import_job_rows (organization_id);
create index if not exists import_job_rows_result_idx on public.import_job_rows (result);
create unique index if not exists import_job_rows_job_row_key
  on public.import_job_rows (import_job_id, row_number);

alter table public.import_job_rows enable row level security;
