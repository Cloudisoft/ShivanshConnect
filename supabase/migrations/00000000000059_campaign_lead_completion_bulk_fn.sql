-- Performance fix: GET /dashboard/charts fetched every campaign_leads ROW
-- (campaign_id, status, attempt_count) for every campaign the org has, TWICE
-- (once for campaign_performance's completion_rate, once for
-- campaign_completion's leads_called), with no limit at all - an org with
-- large lead lists (thousands of rows per campaign, multiple campaigns) was
-- fetching tens of thousands of raw rows just to compute a handful of
-- percentages, on EVERY dashboard load. Reported as "dashboard takes 80
-- seconds to load."
--
-- One grouped aggregate per campaign, same "GROUP BY, never fetch raw rows"
-- principle as 00000000000053's campaign_lead_status_counts_bulk - covers
-- both call sites (one needs `terminal`, the other needs `called`).
create or replace function public.campaign_lead_completion_bulk(p_campaign_ids uuid[])
returns table (campaign_id uuid, total bigint, called bigint, terminal bigint, total_attempts bigint)
language sql
stable
as $$
  select
    campaign_id,
    count(*) as total,
    count(*) filter (where attempt_count > 0) as called,
    count(*) filter (where status in ('completed', 'failed', 'dnc', 'skipped')) as terminal,
    coalesce(sum(attempt_count), 0) as total_attempts
  from public.campaign_leads
  where campaign_id = any(p_campaign_ids)
  group by campaign_id;
$$;
