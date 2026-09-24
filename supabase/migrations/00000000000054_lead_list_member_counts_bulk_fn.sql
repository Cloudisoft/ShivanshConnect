-- Performance fix: GET /lead-lists (fired on every single Leads page open,
-- via useLeadLists(1, 100)) downloaded every row of lead_list_members for
-- every list on the page - just to count them in JavaScript - instead of
-- a grouped SQL count. For a list with thousands of members this pulled
-- thousands of rows over the wire per list, on every single page load.
-- This grouped-count RPC returns every list's member count in ONE round
-- trip with zero row data transferred (just the counts).
create or replace function public.lead_list_member_counts_bulk(p_lead_list_ids uuid[])
returns table (lead_list_id uuid, count bigint)
language sql
stable
as $$
  select lead_list_id, count(*) as count
  from public.lead_list_members
  where lead_list_id = any(p_lead_list_ids)
  group by lead_list_id;
$$;
