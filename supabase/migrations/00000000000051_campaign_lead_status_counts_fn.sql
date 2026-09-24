-- Performance fix: GET /campaigns and GET /campaigns/:id computed each
-- campaign's per-status lead counts as 12 separate COUNT queries (one per
-- CAMPAIGN_LEAD_STATUSES entry) plus 2 more afterward (total lead count,
-- active call count) - 14 sequential/parallel round trips just to render
-- one campaign card. This single grouped-count function returns every
-- status's count in ONE round trip; apps/backend/src/routes/campaigns.ts's
-- computeCampaignCounts() now calls this instead of looping per status.
create or replace function public.campaign_lead_status_counts(p_campaign_id uuid)
returns table (status text, count bigint)
language sql
stable
as $$
  select status, count(*) as count
  from public.campaign_leads
  where campaign_id = p_campaign_id
  group by status;
$$;
