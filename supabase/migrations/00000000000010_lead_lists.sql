-- Phase 2: lead_lists
--
-- A named grouping of leads (e.g. "Q3 Cold Outreach"). Leads exist
-- independently of any list (see 00000000000011_leads.sql) - membership
-- in a list is a many-to-many relationship via lead_list_members
-- (00000000000012_lead_list_members.sql), per master spec section 56
-- which names both `leads` and `lead_list_members` as separate tables.

create table if not exists public.lead_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  description text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists lead_lists_org_name_key on public.lead_lists (organization_id, name);
create index if not exists lead_lists_organization_id_idx on public.lead_lists (organization_id);
create index if not exists lead_lists_created_at_idx on public.lead_lists (created_at);

drop trigger if exists lead_lists_set_updated_at on public.lead_lists;
create trigger lead_lists_set_updated_at
  before update on public.lead_lists
  for each row
  execute function public.set_updated_at();

alter table public.lead_lists enable row level security;
