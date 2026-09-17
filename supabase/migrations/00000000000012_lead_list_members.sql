-- Phase 2: lead_list_members - many-to-many join between leads and lead_lists.
-- organization_id is denormalized onto the join row so RLS/tenant checks
-- and indexes don't need to join back through leads for every row.

create table if not exists public.lead_list_members (
  lead_id uuid not null references public.leads (id) on delete cascade,
  lead_list_id uuid not null references public.lead_lists (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (lead_id, lead_list_id)
);

create index if not exists lead_list_members_lead_id_idx on public.lead_list_members (lead_id);
create index if not exists lead_list_members_lead_list_id_idx on public.lead_list_members (lead_list_id);
create index if not exists lead_list_members_organization_id_idx on public.lead_list_members (organization_id);

alter table public.lead_list_members enable row level security;
